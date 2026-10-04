import { BadRequestException } from '@nestjs/common';
import { randomInt } from 'node:crypto';
import {
  V2_ACCOUNT_OFFERS,
  V2_REGISTRATION_STEPS,
  type V2AccountOffer,
  type V2RegistrationStart,
  type V2RegistrationStep
} from '@apple-business/shared';

export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new BadRequestException('资料格式无效');
  return value as Record<string, unknown>;
}
export function text(value: unknown, label: string, max = 120): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > max ||
    [...value].some((character) => {
      const code = character.codePointAt(0)!;
      return code < 32 || code === 127;
    })
  )
    throw new BadRequestException(`${label}格式无效`);
  return value.trim();
}
export function id(value: unknown): string {
  const result = text(value, '资料编号', 36);
  if (!/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(result))
    throw new BadRequestException('资料编号格式无效');
  return result;
}
export function offer(value: unknown): V2AccountOffer {
  if (!V2_ACCOUNT_OFFERS.includes(value as V2AccountOffer))
    throw new BadRequestException('优惠状况无效');
  return value as V2AccountOffer;
}
export function step(value: unknown): V2RegistrationStep {
  if (!V2_REGISTRATION_STEPS.includes(value as V2RegistrationStep))
    throw new BadRequestException('注册步骤无效');
  return value as V2RegistrationStep;
}
export function birthDate(value: unknown, now = new Date()): string {
  const result = text(value, '出生日期', 10);
  const parsed = new Date(`${result}T00:00:00Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(result) ||
    !Number.isFinite(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== result
  )
    throw new BadRequestException('出生日期无效');
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(now);
  const age =
    Number(today.slice(0, 4)) -
    Number(result.slice(0, 4)) -
    (today.slice(5) < result.slice(5) ? 1 : 0);
  if (age < 20 || age > 45)
    throw new BadRequestException('本功能仅接受实际年龄为 20 至 45 岁的资料');
  return result;
}
export function startInput(
  value: unknown,
  now = new Date()
): V2RegistrationStart & { age: number; birthDate: string } {
  const input = record(value);
  if (
    Object.keys(input).some(
      (key) =>
        !['mailboxAliasId', 'proxyId', 'nameId', 'age', 'birthDate', 'confirmIdentity'].includes(
          key
        )
    )
  )
    throw new BadRequestException('注册资料包含未知字段');
  if (input.confirmIdentity !== true) throw new BadRequestException('请确认邮箱已授权用于注册');
  if (
    input.age != null &&
    (typeof input.age !== 'number' ||
      !Number.isInteger(input.age) ||
      input.age < 20 ||
      input.age > 45)
  )
    throw new BadRequestException('年龄须为 20 至 45 岁的整数');
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(now);
  const legacyBirthday = input.birthDate == null ? null : birthDate(input.birthDate, now);
  const legacyAge = legacyBirthday
    ? Number(today.slice(0, 4)) -
      Number(legacyBirthday.slice(0, 4)) -
      (today.slice(5) < legacyBirthday.slice(5) ? 1 : 0)
    : undefined;
  if (input.age != null && legacyAge != null && input.age !== legacyAge)
    throw new BadRequestException('年龄与出生日期不一致');
  const age = (input.age as number | null | undefined) ?? legacyAge ?? randomInt(20, 46);
  return {
    mailboxAliasId: text(input.mailboxAliasId, '邮箱编号', 191),
    proxyId: id(input.proxyId),
    ...(input.nameId ? { nameId: id(input.nameId) } : {}),
    age,
    // Worker 兼容官网完整日期控件；这只是年龄推导日期，并非用户真实生日。
    birthDate: legacyBirthday ?? `${Number(today.slice(0, 4)) - age}-01-01`,
    confirmIdentity: true
  };
}
