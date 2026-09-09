import { BadRequestException } from '@nestjs/common';
import {
  V2_RECHARGE_ADDRESS_STATUSES,
  type V2RechargeAddressListQuery,
  type V2RechargeAddressStatus
} from '@apple-business/shared';

export const RECHARGE_ADDRESS_LOCATION = Object.freeze({
  country: 'US' as const,
  city: 'Portland' as const,
  state: 'OR' as const,
  postalCode: '97204' as const
});

const streetPattern = /^[A-Za-z0-9][A-Za-z0-9 .,'#/-]{1,179}$/;

function normalizeStreet(value: string) {
  return value.trim().replace(/\s+/g, ' ');
}

export function validateRechargeAddressImport(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new BadRequestException('地址文件内容无效');
  }
  const streets = (value as { streets?: unknown }).streets;
  if (!Array.isArray(streets) || streets.length < 1 || streets.length > 2000) {
    throw new BadRequestException('每次需要导入 1 至 2000 条街道地址');
  }

  const unique = new Map<string, string>();
  let rejected = 0;
  let duplicatedInFile = 0;
  for (const item of streets) {
    if (typeof item !== 'string' || /[\r\n]/.test(item)) {
      rejected += 1;
      continue;
    }
    const street = normalizeStreet(item);
    if (!streetPattern.test(street)) {
      rejected += 1;
      continue;
    }
    const key = street.toLocaleLowerCase('en-US');
    if (unique.has(key)) {
      duplicatedInFile += 1;
      continue;
    }
    unique.set(key, street);
  }
  if (!unique.size) throw new BadRequestException('文件中没有可导入的街道地址');
  return { streets: [...unique.values()], rejected, duplicatedInFile };
}

function integer(value: unknown, fallback: number) {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : Number.NaN;
}

export function validateRechargeAddressListQuery(
  value: unknown
): Required<V2RechargeAddressListQuery> {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const query = input as Record<string, unknown>;
  const page = integer(query.page, 1);
  const pageSize = integer(query.pageSize, 20);
  const keyword = typeof query.keyword === 'string' ? query.keyword.trim() : '';
  const status = typeof query.status === 'string' ? query.status : 'all';
  if (
    page < 1 ||
    page > 100000 ||
    ![20, 50, 100, 2000].includes(pageSize) ||
    keyword.length > 80 ||
    !['all', ...V2_RECHARGE_ADDRESS_STATUSES].includes(status as never)
  ) {
    throw new BadRequestException('地址查询条件无效');
  }
  return { page, pageSize, keyword, status: status as V2RechargeAddressStatus | 'all' };
}

export function validateRechargeAddressStatus(value: unknown): V2RechargeAddressStatus {
  const status =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as { status?: unknown }).status
      : undefined;
  if (!V2_RECHARGE_ADDRESS_STATUSES.includes(status as never)) {
    throw new BadRequestException('地址状态无效');
  }
  return status as V2RechargeAddressStatus;
}
