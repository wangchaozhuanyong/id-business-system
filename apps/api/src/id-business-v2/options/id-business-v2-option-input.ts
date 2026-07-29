import { BadRequestException, ConflictException } from '@nestjs/common';
import {
  IdBusinessV2OptionStatus,
  IdBusinessV2OptionType,
  Prisma as PrismaNamespace
} from '@prisma/client';
import type { Prisma } from '@prisma/client';
import { ID_BUSINESS_V2_OPTION_TYPE_MAP } from './id-business-v2-options.constants';

const OPTION_SORT_FIELDS: Record<string, keyof Prisma.IdBusinessV2OptionOrderByWithRelationInput> =
  {
    name: 'name',
    sortOrder: 'sortOrder',
    status: 'status',
    createdAt: 'createdAt',
    updatedAt: 'updatedAt'
  };

export function normalizeOptionFees(
  type: IdBusinessV2OptionType,
  fixedFeeValue?: string | number,
  percentageFeeValue?: string | number
) {
  const fixedFee = normalizeOptionDecimal(fixedFeeValue, '固定手续费', 4);
  const percentageFee = normalizeOptionDecimal(percentageFeeValue, '百分比手续费', 4);
  const supportsFees = ID_BUSINESS_V2_OPTION_TYPE_MAP.get(type)?.supportsFees;

  if (!supportsFees && (fixedFee !== '0' || percentageFee !== '0')) {
    throw new BadRequestException('只有结算平台可以设置手续费');
  }

  if (new PrismaNamespace.Decimal(percentageFee).greaterThan(100)) {
    throw new BadRequestException('百分比手续费不能超过 100%');
  }

  return { fixedFee, percentageFee };
}

export function normalizeOptionCurrencyCode(value: unknown) {
  const normalized = normalizeNullableString(value)?.toUpperCase() ?? null;
  if (normalized && !/^[A-Z]{3}$/.test(normalized)) {
    throw new BadRequestException('货币代码必须是 3 位英文字母');
  }
  return normalized;
}

export function normalizeOptionDecimal(
  value: string | number | Prisma.Decimal | undefined,
  field: string,
  scale: number
) {
  if (value === undefined || value === '') {
    return '0';
  }

  const normalized = String(value).trim();
  const pattern = new RegExp(`^\\d+(\\.\\d{1,${scale}})?$`);
  if (!pattern.test(normalized)) {
    throw new BadRequestException(`${field}必须是最多 ${scale} 位小数的非负数字`);
  }

  const decimal = new PrismaNamespace.Decimal(normalized);
  if (decimal.greaterThan('99999999999999')) {
    throw new BadRequestException(`${field}数值过大`);
  }

  return decimal.toString();
}

export function normalizeOptionSortOrder(value: string | number | undefined) {
  if (value === undefined || value === '') {
    return 0;
  }

  const normalized = Number(value);
  if (!Number.isInteger(normalized) || normalized < 0 || normalized > 99999) {
    throw new BadRequestException('排序必须是 0 到 99999 之间的整数');
  }

  return normalized;
}

export function normalizeOptionName(value: unknown) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new BadRequestException('选项名称不能为空');
  }

  const normalized = value.trim().replace(/\s+/g, ' ');
  if (normalized.length > 160) {
    throw new BadRequestException('选项名称不能超过 160 个字符');
  }

  return normalized;
}

export function normalizeNullableString(value: unknown) {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim();
  return normalized || null;
}

export function parseOptionType(value: unknown, required: true): IdBusinessV2OptionType;
export function parseOptionType(
  value: unknown,
  required: false
): IdBusinessV2OptionType | undefined;
export function parseOptionType(value: unknown, required: boolean) {
  if ((value === undefined || value === null || value === '') && !required) {
    return undefined;
  }

  if (
    typeof value === 'string' &&
    Object.values(IdBusinessV2OptionType).includes(value as IdBusinessV2OptionType) &&
    ID_BUSINESS_V2_OPTION_TYPE_MAP.has(value as IdBusinessV2OptionType)
  ) {
    return value as IdBusinessV2OptionType;
  }

  throw new BadRequestException('选项类型不正确');
}

export function parseOptionStatus(value: unknown, required: true): IdBusinessV2OptionStatus;
export function parseOptionStatus(
  value: unknown,
  required: false
): IdBusinessV2OptionStatus | undefined;
export function parseOptionStatus(value: unknown, required: boolean) {
  if ((value === undefined || value === null || value === '') && !required) {
    return undefined;
  }

  if (
    typeof value === 'string' &&
    Object.values(IdBusinessV2OptionStatus).includes(value as IdBusinessV2OptionStatus)
  ) {
    return value as IdBusinessV2OptionStatus;
  }

  throw new BadRequestException('选项状态不正确');
}

export function buildOptionUniqueKey(
  type: IdBusinessV2OptionType,
  parentId: string | null,
  countryOptionId: string | null,
  name: string
) {
  const scope =
    type === 'service'
      ? `${countryOptionId ?? 'country-missing'}:${parentId ?? 'category-missing'}`
      : (parentId ?? 'root');
  return `${type}:${scope}:${name.toLocaleLowerCase('zh-CN')}`;
}

export function buildOptionOrderBy(sortBy?: string, sortOrder?: string) {
  const sortField = sortBy ? OPTION_SORT_FIELDS[sortBy] : undefined;
  const direction = sortOrder === 'desc' ? 'desc' : 'asc';

  if (!sortField) {
    return [{ sortOrder: 'asc' as const }, { name: 'asc' as const }];
  }

  return [{ [sortField]: direction }, { id: 'asc' as const }];
}

export function rethrowOptionUniqueConstraint(error: unknown): never {
  if (error instanceof PrismaNamespace.PrismaClientKnownRequestError && error.code === 'P2002') {
    throw new ConflictException('同一类型和上级下已存在同名选项');
  }

  throw error;
}
