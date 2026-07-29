import { BadRequestException, ConflictException } from '@nestjs/common';
import {
  IdBusinessV2AccountLockScope,
  IdBusinessV2OrderAccountDisposition,
  Prisma as PrismaNamespace
} from '@prisma/client';
import type { IdBusinessV2AccountLock, IdBusinessV2Order, Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import type { AuthenticatedUser } from '../../auth/auth.types';
import type { CreateIdBusinessV2OrderDto } from './dto/create-id-business-v2-order.dto';
import { V2_DECIMAL_PATTERN, V2_DECIMAL_PLACES, V2_DECIMAL_ROUNDING_MODE } from '../decimal-policy';

export interface NormalizedCreateOrderInput {
  customerId: string;
  serviceOptionId: string;
  accountId: string;
  accountDisposition: IdBusinessV2OrderAccountDisposition;
  settlementPlatformOptionId: string | null;
  platformOrderNo: string | null;
  websiteAccount: string | null;
  websiteAccountHash: string | null;
  receivedAmount: PrismaNamespace.Decimal;
  balanceAmount: PrismaNamespace.Decimal;
  openedAt: Date;
  dueAt: Date;
  lockScope: IdBusinessV2AccountLockScope;
  idempotencyKey: string;
  remark: string | null;
}

export interface OrderEntryLockSummary {
  id: string;
  serviceOptionId: string | null;
  lockScope: IdBusinessV2AccountLockScope;
  status: string;
  lockedAt: Date;
  expiresAt: Date;
  endedAt: Date | null;
  endReason: string | null;
  reason: string | null;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,100}$/;
const MAX_AMOUNT = new PrismaNamespace.Decimal('99999999999999.9999');

export function normalizeCreateOrderInput(
  dto: CreateIdBusinessV2OrderDto,
  hash: (value: string | null) => string | null
): NormalizedCreateOrderInput {
  const customerId = normalizeUuid(dto.customerId, '客户');
  const serviceOptionId = normalizeUuid(dto.serviceOptionId, '业务');
  const accountId = normalizeUuid(dto.accountId, '使用 ID');
  const accountDisposition = normalizeAccountDisposition(dto.accountDisposition);
  const settlementPlatformOptionId = normalizeOptionalUuid(
    dto.settlementPlatformOptionId,
    '结算平台'
  );
  const platformOrderNo = normalizeOptionalString(dto.platformOrderNo, '平台订单号', 160);
  if (platformOrderNo && !settlementPlatformOptionId) {
    throw new BadRequestException('填写平台订单号时必须选择结算平台');
  }

  const websiteAccount = normalizeOptionalString(dto.websiteAccount, '客户网站账号', 255);
  const receivedAmount = normalizeAmount(dto.receivedAmount, '实收金额', true);
  const balanceAmount = normalizeAmount(dto.balanceAmount, '消耗余额', false);
  const openedAt = normalizeDate(dto.openedAt, '开通时间');
  const dueAt = normalizeDate(dto.dueAt, '到期时间');
  if (dueAt.getTime() <= openedAt.getTime()) {
    throw new BadRequestException('到期时间必须晚于开通时间');
  }
  if (dueAt.getTime() <= Date.now()) {
    throw new BadRequestException('到期时间必须晚于当前时间');
  }

  return {
    customerId,
    serviceOptionId,
    accountId,
    accountDisposition,
    settlementPlatformOptionId,
    platformOrderNo,
    websiteAccount,
    websiteAccountHash: hash(websiteAccount),
    receivedAmount,
    balanceAmount,
    openedAt,
    dueAt,
    lockScope:
      accountDisposition === IdBusinessV2OrderAccountDisposition.sold
        ? IdBusinessV2AccountLockScope.global
        : normalizeLockScope(dto.lockScope),
    idempotencyKey: buildIdempotencyKey(normalizeIdempotencyKey(dto.idempotencyKey)),
    remark: normalizeOptionalString(dto.remark, '备注', 2000)
  };
}

export function calculatePlatformFee(
  receivedAmount: PrismaNamespace.Decimal,
  platform: {
    fixedFee: PrismaNamespace.Decimal;
    percentageFee: PrismaNamespace.Decimal;
  } | null
) {
  if (!platform) return new PrismaNamespace.Decimal(0);
  const platformFeeAmount = platform.fixedFee
    .plus(receivedAmount.mul(platform.percentageFee).div(100))
    .toDecimalPlaces(V2_DECIMAL_PLACES, V2_DECIMAL_ROUNDING_MODE);
  if (platformFeeAmount.greaterThan(MAX_AMOUNT)) {
    throw new BadRequestException('平台手续费数值过大');
  }
  return platformFeeAmount;
}

export function assertOrderEntryReplayMatches(
  order: IdBusinessV2Order,
  lock: IdBusinessV2AccountLock | null,
  input: NormalizedCreateOrderInput
) {
  if (order.deletedAt) {
    throw new ConflictException('该幂等请求对应的订单已经删除，不能重新创建');
  }
  if (
    order.customerId !== input.customerId ||
    order.serviceOptionId !== input.serviceOptionId ||
    order.accountId !== input.accountId ||
    order.accountDisposition !== input.accountDisposition ||
    order.settlementPlatformOptionId !== input.settlementPlatformOptionId ||
    order.platformOrderNo !== input.platformOrderNo ||
    order.websiteAccountHash !== input.websiteAccountHash ||
    !order.receivedAmount.equals(input.receivedAmount) ||
    !order.balanceAmount.equals(input.balanceAmount) ||
    order.openedAt?.getTime() !== input.openedAt.getTime() ||
    order.dueAt?.getTime() !== input.dueAt.getTime() ||
    order.remark !== input.remark ||
    lock?.accountId !== input.accountId ||
    lock.lockScope !== input.lockScope
  ) {
    throw new ConflictException('幂等键已用于其他订单内容，请刷新后重新提交');
  }
}

export async function writeOrderEntryAuditLog(
  tx: Prisma.TransactionClient,
  order: IdBusinessV2Order,
  input: NormalizedCreateOrderInput,
  platformFeeAmount: PrismaNamespace.Decimal,
  lock: {
    id: string;
    lockScope: IdBusinessV2AccountLockScope;
    expiresAt: Date;
  },
  operator?: AuthenticatedUser
) {
  await tx.auditLog.create({
    data: {
      userId: operator?.id,
      module: 'id_business_v2',
      action: 'id_business_v2.order.create_pending',
      objectType: 'id_business_v2_order',
      objectId: order.id,
      afterData: {
        orderNo: order.orderNo,
        customerId: input.customerId,
        serviceOptionId: input.serviceOptionId,
        accountId: input.accountId,
        accountDisposition: input.accountDisposition,
        accountCostAmount: order.accountCostAmount.toString(),
        settlementPlatformOptionId: input.settlementPlatformOptionId,
        platformOrderNo: input.platformOrderNo,
        websiteAccountMasked: maskWebsiteAccount(input.websiteAccount),
        receivedAmount: input.receivedAmount.toString(),
        platformFeeAmount: platformFeeAmount.toString(),
        balanceAmount: input.balanceAmount.toString(),
        openedAt: input.openedAt,
        dueAt: input.dueAt,
        status: 'pending',
        lockId: lock.id,
        lockScope: lock.lockScope,
        lockExpiresAt: lock.expiresAt,
        nextStep: 'waiting_balance_consumption'
      },
      remark: `创建 V2 待处理订单并锁定 ID：${order.orderNo}`
    }
  });
}

export function toOrderEntryLockSummary(
  lock: IdBusinessV2AccountLock | null
): OrderEntryLockSummary | null {
  if (!lock) return null;
  return {
    id: lock.id,
    serviceOptionId: lock.serviceOptionId,
    lockScope: lock.lockScope,
    status: lock.status,
    lockedAt: lock.lockedAt,
    expiresAt: lock.expiresAt,
    endedAt: lock.endedAt,
    endReason: lock.endReason,
    reason: lock.reason
  };
}

export function normalizeUuid(value: unknown, label: string) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!UUID_PATTERN.test(normalized)) throw new BadRequestException(`${label}格式无效`);
  return normalized;
}

export function normalizeOptionalString(value: unknown, label: string, maxLength: number) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new BadRequestException(`${label}格式无效`);
  }
  const normalized = String(value).trim();
  if (normalized.length > maxLength) {
    throw new BadRequestException(`${label}不能超过 ${maxLength} 个字符`);
  }
  return normalized || null;
}

export function generateOrderNo() {
  const day = new Date().toISOString().slice(0, 10).replaceAll('-', '');
  return `V2${day}${randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase()}`;
}

export function maskWebsiteAccount(value: string | null) {
  if (!value) return null;
  const [name, domain] = value.split('@');
  if (domain) {
    const prefix = name.length <= 2 ? `${name[0] ?? '*'}***` : `${name.slice(0, 2)}***`;
    return `${prefix}@${domain}`;
  }
  if (value.length <= 4) return '****';
  return `${value.slice(0, 2)}***${value.slice(-2)}`;
}

export function isUniqueConstraintError(error: unknown) {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'P2002'
  );
}

function normalizeOptionalUuid(value: unknown, label: string) {
  if (value === undefined || value === null || value === '') return null;
  return normalizeUuid(value, label);
}

function normalizeAmount(value: unknown, label: string, allowZero: boolean) {
  const normalized =
    typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
  if (!V2_DECIMAL_PATTERN.test(normalized)) {
    throw new BadRequestException(`${label}必须是最多 ${V2_DECIMAL_PLACES} 位小数的非负数`);
  }
  const amount = new PrismaNamespace.Decimal(normalized);
  if ((!allowZero && amount.lessThanOrEqualTo(0)) || (allowZero && amount.lessThan(0))) {
    throw new BadRequestException(`${label}${allowZero ? '不能为负数' : '必须大于 0'}`);
  }
  if (amount.greaterThan(MAX_AMOUNT)) throw new BadRequestException(`${label}数值过大`);
  return amount;
}

function normalizeDate(value: unknown, label: string) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new BadRequestException(`${label}不能为空`);
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new BadRequestException(`${label}格式无效`);
  return date;
}

function normalizeLockScope(value: unknown): IdBusinessV2AccountLockScope {
  if (value === undefined || value === null || value === '') {
    return IdBusinessV2AccountLockScope.by_service;
  }
  if (
    value === IdBusinessV2AccountLockScope.by_service ||
    value === IdBusinessV2AccountLockScope.global
  ) {
    return value;
  }
  throw new BadRequestException('锁定范围无效');
}

function normalizeAccountDisposition(value: unknown): IdBusinessV2OrderAccountDisposition {
  if (value === IdBusinessV2OrderAccountDisposition.retained) {
    return IdBusinessV2OrderAccountDisposition.retained;
  }
  if (value === IdBusinessV2OrderAccountDisposition.sold) {
    return IdBusinessV2OrderAccountDisposition.sold;
  }
  throw new BadRequestException('ID 处理方式必须选择保留或卖出');
}

function normalizeIdempotencyKey(value: unknown) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!IDEMPOTENCY_KEY_PATTERN.test(normalized)) {
    throw new BadRequestException('幂等键必须是 8 至 100 位字母、数字或 ._:-');
  }
  return normalized;
}

function buildIdempotencyKey(value: string) {
  return `order_entry:${value}`;
}
