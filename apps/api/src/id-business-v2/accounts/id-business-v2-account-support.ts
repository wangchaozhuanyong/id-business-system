import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import type { IdBusinessV2Account, IdBusinessV2RecordStatus, Prisma } from '@prisma/client';
import { Prisma as PrismaNamespace } from '@prisma/client';
import { toV2DecimalString } from '../decimal-policy';
import type { AuthenticatedUser } from '../../auth/auth.types';
import type { PaginationQuery } from '../../common/pagination';
import type { IdBusinessV2AccountSecretField } from './dto/reveal-id-business-v2-account-secret.dto';

export interface AccountListQuery extends PaginationQuery {
  keyword?: string;
  countryOptionId?: string;
  statusOptionId?: string;
  supplierOptionId?: string;
  recordStatus?: string;
  saleState?: string;
  sortBy?: string;
  sortOrder?: string;
}

interface SecretFieldConfig {
  field: IdBusinessV2AccountSecretField;
  permission: string;
  label: string;
}

export const ACCOUNT_INCLUDE = {
  countryOption: {
    select: {
      id: true,
      code: true,
      name: true
    }
  },
  statusOption: {
    select: {
      id: true,
      code: true,
      name: true,
      isSystem: true
    }
  },
  supplierOption: {
    select: {
      id: true,
      code: true,
      name: true
    }
  },
  soldByOrder: {
    select: {
      id: true,
      orderNo: true
    }
  }
} satisfies Prisma.IdBusinessV2AccountInclude;

export type AccountWithRelations = Prisma.IdBusinessV2AccountGetPayload<{
  include: typeof ACCOUNT_INCLUDE;
}>;

export const SECRET_FIELDS: Record<IdBusinessV2AccountSecretField, SecretFieldConfig> = {
  appleId: {
    field: 'appleId',
    permission: 'apple.account.view_full',
    label: 'Apple ID 账号'
  },
  password: {
    field: 'password',
    permission: 'apple.secret.view_password',
    label: 'Apple ID 密码'
  },
  phone: {
    field: 'phone',
    permission: 'apple.secret.view_phone',
    label: '手机号码'
  },
  securityInfo: {
    field: 'securityInfo',
    permission: 'apple.secret.view_security',
    label: '密保资料'
  }
};

const ACCOUNT_SORT_FIELDS: Record<
  string,
  keyof Prisma.IdBusinessV2AccountOrderByWithRelationInput
> = {
  appleId: 'appleIdMasked',
  currentBalance: 'currentBalance',
  balanceCostAmount: 'balanceCostAmount',
  purchaseCost: 'purchaseCost',
  recordStatus: 'recordStatus',
  createdAt: 'createdAt',
  updatedAt: 'updatedAt'
};

export function buildAccountWhere(
  query: AccountListQuery,
  hash: (value: string | null) => string | null
): Prisma.IdBusinessV2AccountWhereInput {
  const keyword = normalizeNullableString(query.keyword);
  const normalizedAppleId = keyword ? normalizeAppleId(keyword, false) : null;
  const normalizedPhone = keyword ? normalizePhone(keyword) : null;
  const saleState = parseSaleState(query.saleState);
  return {
    deletedAt: null,
    countryOptionId: normalizeNullableString(query.countryOptionId) ?? undefined,
    statusOptionId: normalizeNullableString(query.statusOptionId) ?? undefined,
    supplierOptionId: normalizeNullableString(query.supplierOptionId) ?? undefined,
    recordStatus: parseRecordStatus(query.recordStatus, false) ?? undefined,
    soldByOrderId:
      saleState === 'sold' ? { not: null } : saleState === 'available' ? null : undefined,
    OR: keyword
      ? [
          { appleIdMasked: { contains: keyword, mode: 'insensitive' } },
          { appleIdHash: hash(normalizedAppleId) ?? undefined },
          {
            phoneTail: {
              contains: normalizedPhone?.slice(-8) ?? keyword,
              mode: 'insensitive'
            }
          },
          { phoneHash: hash(normalizedPhone) ?? undefined },
          {
            supplierOption: {
              name: {
                contains: keyword,
                mode: 'insensitive'
              }
            }
          }
        ]
      : undefined
  };
}

export function buildAccountOrderBy(query: AccountListQuery) {
  const field = query.sortBy ? ACCOUNT_SORT_FIELDS[query.sortBy] : undefined;
  if (!field) {
    return [
      { updatedAt: 'desc' },
      { id: 'desc' }
    ] satisfies Prisma.IdBusinessV2AccountOrderByWithRelationInput[];
  }
  const direction = query.sortOrder === 'desc' ? 'desc' : 'asc';
  return [
    { [field]: direction },
    { updatedAt: 'desc' },
    { id: 'desc' }
  ] as Prisma.IdBusinessV2AccountOrderByWithRelationInput[];
}

export function parseRecordStatus(
  value: unknown,
  required: boolean
): IdBusinessV2RecordStatus | null {
  if (value === undefined || value === null || value === '') {
    if (required) throw new BadRequestException('资料状态不能为空');
    return null;
  }
  if (value !== 'active' && value !== 'disabled') {
    throw new BadRequestException('资料状态无效');
  }
  return value;
}

export function parseSaleState(value: unknown): 'available' | 'sold' | null {
  if (value === undefined || value === null || value === '') return null;
  if (value === 'available' || value === 'sold') return value;
  throw new BadRequestException('销售状态无效');
}

export function parseSecretField(value: unknown): IdBusinessV2AccountSecretField {
  if (
    value === 'appleId' ||
    value === 'password' ||
    value === 'phone' ||
    value === 'securityInfo'
  ) {
    return value;
  }
  throw new BadRequestException('敏感字段类型无效');
}

export function assertSecretPermission(config: SecretFieldConfig, operator?: AuthenticatedUser) {
  if (
    operator &&
    (operator.roles.includes('admin') || operator.permissions.includes(config.permission))
  ) {
    return;
  }
  throw new ForbiddenException(`无权查看${config.label}`);
}

export function assertBalanceAdjustmentPermission(operator?: AuthenticatedUser) {
  if (
    operator &&
    (operator.roles.includes('admin') || operator.permissions.includes('apple.balance.adjust'))
  ) {
    return;
  }
  throw new ForbiddenException('无权录入或修改 ID 余额和人民币成本');
}

export function getEncryptedSecretValue(
  account: IdBusinessV2Account,
  field: IdBusinessV2AccountSecretField
) {
  if (field === 'appleId') return account.appleIdEncrypted;
  if (field === 'password') return account.passwordEncrypted;
  if (field === 'phone') return account.phoneEncrypted;
  return account.securityInfoEncrypted;
}

export function normalizeAppleId(value: unknown, required: boolean) {
  const normalized = normalizeNullableString(value)?.toLocaleLowerCase('en-US') ?? null;
  if (!normalized && required) throw new BadRequestException('Apple ID 账号不能为空');
  if (normalized && normalized.length > 255) {
    throw new BadRequestException('Apple ID 账号过长');
  }
  return normalized;
}

export function normalizePhone(value: unknown) {
  const phone = normalizeNullableString(value);
  if (!phone) return null;
  const normalized = phone.replace(/[\s()-]/g, '');
  if (normalized.length > 40) throw new BadRequestException('手机号码过长');
  return normalized;
}

export function normalizeNullableString(value: unknown) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new BadRequestException('字段格式无效');
  return value.trim() || null;
}

export function normalizeMoney(value: unknown, label: string) {
  const raw = value === undefined || value === null || value === '' ? '0' : String(value);
  try {
    const decimal = new PrismaNamespace.Decimal(raw);
    if (decimal.isNegative()) throw new BadRequestException(`${label}不能为负数`);
    return toV2DecimalString(decimal);
  } catch (error) {
    if (error instanceof BadRequestException) throw error;
    throw new BadRequestException(`${label}格式无效`);
  }
}

export function requireBalanceSnapshotValue(value: unknown, label: string) {
  if (value === undefined || value === null || value === '') {
    throw new BadRequestException(`${label}不能为空`);
  }
  return value as PrismaNamespace.Decimal.Value;
}

export function normalizeBalanceAdjustmentReason(value: unknown) {
  const reason = normalizeNullableString(value);
  if (!reason || reason.length < 2) {
    throw new BadRequestException('余额修正原因至少需要 2 个字');
  }
  if (reason.length > 200) {
    throw new BadRequestException('余额修正原因不能超过 200 个字');
  }
  return reason;
}

export function normalizeBalanceAdjustmentIdempotencyKey(value: unknown) {
  const key = normalizeNullableString(value);
  if (!key || !/^[A-Za-z0-9._:-]{8,100}$/.test(key)) {
    throw new BadRequestException('余额修正幂等键格式无效');
  }
  return key;
}

export function normalizeRevealReason(value: unknown) {
  const reason = normalizeNullableString(value);
  if (!reason) throw new BadRequestException('查看原因不能为空');
  if (reason.length > 200) throw new BadRequestException('查看原因过长');
  return reason;
}

export function maskAppleId(value: string) {
  const [name, domain] = value.split('@');
  if (!domain) return `${value.slice(0, 2)}***${value.slice(-2)}`;
  return `${name.slice(0, 2)}${'*'.repeat(Math.max(3, name.length - 2))}@${domain}`;
}

export function maskPhone(value: string | null) {
  if (!value) return null;
  if (value.length <= 4) return '****';
  return `${value.slice(0, 3)}****${value.slice(-4)}`;
}

export function toAccountResponse(account: AccountWithRelations) {
  return {
    id: account.id,
    appleIdMasked: account.appleIdMasked,
    hasPassword: Boolean(account.passwordEncrypted),
    hasPhone: Boolean(account.phoneEncrypted),
    maskedPhone: account.phoneMasked,
    phoneTail: account.phoneTail,
    hasSecurityInfo: Boolean(account.securityInfoEncrypted),
    countryOptionId: account.countryOptionId,
    country: account.countryOption,
    statusOptionId: account.statusOptionId,
    status: account.statusOption,
    supplierOptionId: account.supplierOptionId,
    supplier: account.supplierOption,
    currentBalance: toV2DecimalString(account.currentBalance),
    balanceCostAmount: toV2DecimalString(account.balanceCostAmount),
    purchaseCost: toV2DecimalString(account.purchaseCost),
    saleState: account.soldByOrderId ? ('sold' as const) : ('available' as const),
    soldAt: account.soldAt,
    soldByOrder: account.soldByOrder,
    lossStatus: account.lossReportedAt ? ('reported' as const) : ('active' as const),
    lossReportedAt: account.lossReportedAt,
    recordStatus: account.recordStatus,
    remark: account.remark,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt
  };
}

export function toAuditJson(value: unknown) {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

export function assertBalanceAdjustmentReplay(
  entry: {
    accountId: string;
    entryType: string;
    balanceBefore: PrismaNamespace.Decimal;
    balanceAfter: PrismaNamespace.Decimal;
    costBefore: PrismaNamespace.Decimal;
    costAfter: PrismaNamespace.Decimal;
    remark: string | null;
  },
  expected: {
    accountId: string;
    expectedBalance: PrismaNamespace.Decimal;
    expectedCost: PrismaNamespace.Decimal;
    targetBalance: PrismaNamespace.Decimal;
    targetCost: PrismaNamespace.Decimal;
    reason: string;
  }
) {
  if (
    entry.accountId !== expected.accountId ||
    entry.entryType !== 'manual_adjustment' ||
    !entry.balanceBefore.equals(expected.expectedBalance) ||
    !entry.costBefore.equals(expected.expectedCost) ||
    !entry.balanceAfter.equals(expected.targetBalance) ||
    !entry.costAfter.equals(expected.targetCost) ||
    entry.remark !== expected.reason
  ) {
    throw new ConflictException('余额修正幂等键已被其他请求使用');
  }
}
