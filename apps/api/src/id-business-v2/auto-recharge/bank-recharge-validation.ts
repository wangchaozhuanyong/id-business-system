import { BadRequestException } from '@nestjs/common';
import { Amount4, Rate8 } from '../runtime/public-api';

export const bankRechargeUuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const moneyPattern = /^(?:0|[1-9]\d{0,12})(?:\.\d{1,4})?$/;
const ratePattern = /^(?:0|[1-9]\d{0,2})(?:\.\d{1,4})?$/;

export function bankRechargeObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new BadRequestException('请求格式无效');
  }
  return value as Record<string, unknown>;
}

export function bankRechargeText(value: unknown, label: string, max: number, required = true) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (
    (required && !text) ||
    text.length > max ||
    [...text].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
  ) {
    throw new BadRequestException(`${label}格式无效`);
  }
  return text;
}

export function bankRechargeEmail(value: unknown) {
  const email = bankRechargeText(value, 'ChatGPT 邮箱', 250).toLowerCase();
  if (!emailPattern.test(email)) throw new BadRequestException('ChatGPT 邮箱格式无效');
  return email;
}

export function bankRechargePassword(value: unknown) {
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > 1024 ||
    [...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
  ) {
    throw new BadRequestException('登录密码格式无效');
  }
  return value;
}

export function bankRechargeMaskedEmail(email: string) {
  const [local, domain] = email.split('@');
  return `${local!.slice(0, 2)}***@${domain}`;
}

export function bankRechargeCurrency(value: unknown) {
  const code = typeof value === 'string' ? value.trim().toUpperCase() : '';
  if (!/^[A-Z]{3}$/.test(code)) throw new BadRequestException('币种代码无效');
  return code;
}

export function bankRechargeMoney(value: unknown, label: string, minorUnits = 4, positive = false) {
  if (typeof value !== 'string' || !moneyPattern.test(value)) {
    throw new BadRequestException(`${label}金额格式无效`);
  }
  const places = value.split('.')[1]?.length ?? 0;
  if (places > minorUnits) throw new BadRequestException(`${label}超过币种小数位数`);
  const amount = Amount4.from(value);
  if (positive && !amount.gt('0')) throw new BadRequestException(`${label}必须大于 0`);
  return amount;
}

export function bankRechargeFeeRate(value: unknown) {
  if (typeof value !== 'string' || !ratePattern.test(value)) {
    throw new BadRequestException('手续费百分比格式无效');
  }
  const rate = Amount4.from(value);
  if (rate.gt('100')) throw new BadRequestException('手续费百分比不能超过 100%');
  return rate;
}

export function bankRechargeDate(value: unknown, label: string) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value)) {
    throw new BadRequestException(`${label}格式无效`);
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new BadRequestException(`${label}格式无效`);
  return date;
}

export function bankRechargeId(value: unknown, label: string) {
  if (typeof value !== 'string' || !bankRechargeUuid.test(value)) {
    throw new BadRequestException(`${label}格式无效`);
  }
  return value;
}

export function bankRechargeOptionalId(value: unknown, label: string) {
  if (value === null || value === undefined || value === '') return null;
  return bankRechargeId(value, label);
}

export function bankRechargeFee(charge: Amount4, percent: Amount4, minorUnits: number) {
  return Amount4.from(charge.mul(percent).div('100').toFixed(minorUnits));
}

const FX_RATE_PATTERN = /^(?:0|[1-9]\d{0,8})(?:\.\d{1,8})?$/;
export function bankRechargeFxRate(
  value: unknown,
  previous: { toString(): string } | null,
  label: string
) {
  if (value === undefined) return previous?.toString() ?? null;
  if (value === null || value === '') return null;
  if (typeof value !== 'string' || !FX_RATE_PATTERN.test(value)) {
    throw new BadRequestException(`${label}格式无效`);
  }
  const rate = Rate8.from(value);
  if (!rate.gt('0')) throw new BadRequestException(`${label}必须大于 0`);
  return rate.toString();
}
