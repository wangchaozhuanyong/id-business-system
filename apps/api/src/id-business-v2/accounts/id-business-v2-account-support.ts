import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { Amount4, Rate8, type V2DecimalInput } from '../runtime/public-api';
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

export type AccountRecordStatus = 'active' | 'disabled';

export interface AccountWithRelations {
  id: string;
  appleIdEncrypted: string;
  appleIdHash: string;
  appleIdMasked: string;
  passwordEncrypted: string | null;
  phoneEncrypted: string | null;
  phoneHash: string | null;
  phoneMasked: string | null;
  phoneTail: string | null;
  securityInfoEncrypted: string | null;
  countryOptionId: string;
  statusOptionId: string;
  supplierOptionId: string | null;
  currentBalance: Amount4;
  balanceCostAmount: Amount4;
  purchaseCost: Amount4;
  purchaseOriginalAmount: Amount4;
  purchaseCurrency: 'CNY' | 'MYR' | 'USD' | 'USDT';
  purchaseFxRateToCny: Rate8;
  purchaseFxSnapshotId: string | null;
  purchaseFinanceAccountId: string | null;
  purchaseSupplierAccountId: string | null;
  purchasedAt: Date;
  soldByOrderId: string | null;
  soldAt: Date | null;
  lossReportedAt: Date | null;
  activeLossRecordId: string | null;
  recordStatus: AccountRecordStatus;
  remark: string | null;
  createdByUserId: string | null;
  updatedByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
  countryOption: { id: string; code: string; name: string };
  statusOption: { id: string; code: string; name: string; isSystem: boolean };
  supplierOption: { id: string; code: string; name: string } | null;
  soldByOrder: { id: string; orderNo: string } | null;
  createdBy: { id: string; username: string; displayName: string } | null;
}

export interface AccountUpdateData {
  appleIdEncrypted?: string;
  appleIdHash?: string;
  appleIdMasked?: string;
  passwordEncrypted?: string | null;
  phoneEncrypted?: string | null;
  phoneHash?: string | null;
  phoneMasked?: string | null;
  phoneTail?: string | null;
  securityInfoEncrypted?: string | null;
  countryOptionId?: string;
  statusOptionId?: string;
  supplierOptionId?: string | null;
  purchaseCost?: string;
  recordStatus?: AccountRecordStatus;
  remark?: string | null;
  updatedByUserId?: string;
}

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

export function parseRecordStatus(value: unknown, required: boolean): AccountRecordStatus | null {
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
  account: AccountWithRelations,
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
    const decimal = Amount4.from(raw);
    if (decimal.isNegative()) throw new BadRequestException(`${label}不能为负数`);
    return decimal.toString();
  } catch (error) {
    if (error instanceof BadRequestException) throw error;
    throw new BadRequestException(`${label}格式无效`);
  }
}

export function requireBalanceSnapshotValue(value: unknown, label: string) {
  if (value === undefined || value === null || value === '') {
    throw new BadRequestException(`${label}不能为空`);
  }
  return value as V2DecimalInput;
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

export function normalizeRevealReason(value: unknown, fallback?: string) {
  const reason = normalizeNullableString(value);
  if (!reason && fallback) return fallback;
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
    currentBalance: account.currentBalance.toString(),
    balanceCostAmount: account.balanceCostAmount.toString(),
    purchaseCost: account.purchaseCost.toString(),
    purchaseOriginalAmount: account.purchaseOriginalAmount.toString(),
    purchaseCurrency: account.purchaseCurrency,
    purchaseFxRateToCny: account.purchaseFxRateToCny.toString(),
    purchaseFxSnapshotId: account.purchaseFxSnapshotId,
    purchaseFinanceAccountId: account.purchaseFinanceAccountId,
    purchaseSupplierAccountId: account.purchaseSupplierAccountId,
    purchasedAt: account.purchasedAt,
    saleState: account.soldByOrderId ? ('sold' as const) : ('available' as const),
    soldAt: account.soldAt,
    soldByOrder: account.soldByOrder,
    lossStatus: account.lossReportedAt ? ('reported' as const) : ('active' as const),
    lossReportedAt: account.lossReportedAt,
    activeLossId: account.activeLossRecordId,
    recordStatus: account.recordStatus,
    remark: account.remark,
    createdBy: account.createdBy,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt
  };
}

export function assertBalanceAdjustmentReplay(
  entry: {
    accountId: string;
    entryType: string;
    balanceBefore: Amount4;
    balanceAfter: Amount4;
    costBefore: Amount4;
    costAfter: Amount4;
    remark: string | null;
  },
  expected: {
    accountId: string;
    expectedBalance: V2DecimalInput;
    expectedCost: V2DecimalInput;
    targetBalance: V2DecimalInput;
    targetCost: V2DecimalInput;
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
