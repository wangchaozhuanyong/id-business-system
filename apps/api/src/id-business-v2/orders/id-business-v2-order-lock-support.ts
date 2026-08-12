import { BadRequestException, ConflictException } from '@nestjs/common';
import type { Amount4 } from '../runtime/public-api';
import type {
  IdBusinessV2AccountLockScope,
  IdBusinessV2OrderAccountDisposition,
  IdBusinessV2OrderAccountSource,
  IdBusinessV2OrderStatus
} from './id-business-v2-order.types';

export interface LockedOrderRow {
  id: string;
  orderNo: string;
  customerId: string;
  serviceOptionId: string;
  accountId: string | null;
  accountSource: IdBusinessV2OrderAccountSource;
  sourceSoldOrderId: string | null;
  receivedAmount: Amount4;
  platformFeeAmount: Amount4;
  accountCostAmount: Amount4;
  appliedAccountCostAmount: Amount4;
  accountDisposition: IdBusinessV2OrderAccountDisposition;
  balanceAmount: Amount4;
  balanceCostAmount: Amount4;
  refundCostAmount: Amount4 | null;
  profitAmount: Amount4 | null;
  status: IdBusinessV2OrderStatus;
}

export interface LockedAccountRow {
  id: string;
  appleIdMasked: string;
  currentBalance: Amount4;
  balanceCostAmount: Amount4;
  purchaseCost: Amount4;
  soldByOrderId: string | null;
  soldByCustomerId: string | null;
  lossReportedAt: Date | null;
  countryOptionId: string;
  statusCode: string;
}

export interface ReserveAccountForOrderInput {
  orderId: string;
  accountId: string;
  expiresAt: Date | string;
  lockScope?: IdBusinessV2AccountLockScope;
  reason?: string | null;
}

export interface PrepareOrderConsumptionInput {
  orderId: string;
  idempotencyKey: string;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,100}$/;
const RESERVABLE_ORDER_STATUSES = new Set<IdBusinessV2OrderStatus>([
  'draft',
  'pending',
  'processing'
]);

export function assertReservableOrder(order: LockedOrderRow) {
  if (!RESERVABLE_ORDER_STATUSES.has(order.status)) {
    throw new ConflictException('当前订单状态不能锁定 ID');
  }
}

export function assertReservationReplayMatches(
  lock: {
    accountId: string;
    serviceOptionId: string | null;
    lockScope: IdBusinessV2AccountLockScope;
    expiresAt: Date;
    reason: string | null;
  },
  input: Required<Pick<ReserveAccountForOrderInput, 'orderId' | 'accountId'>> & {
    expiresAt: Date;
    lockScope: IdBusinessV2AccountLockScope;
    reason: string | null;
  },
  serviceOptionId: string
) {
  if (
    lock.accountId !== input.accountId ||
    lock.lockScope !== input.lockScope ||
    lock.serviceOptionId !== (input.lockScope === 'by_service' ? serviceOptionId : null) ||
    lock.expiresAt.getTime() !== input.expiresAt.getTime() ||
    lock.reason !== input.reason
  ) {
    throw new ConflictException('订单已有不同的活动锁，不能用新内容覆盖');
  }
}

export function toReservationResponse(
  order: LockedOrderRow,
  account: LockedAccountRow,
  lock: Parameters<typeof toLockSummary>[0],
  idempotentReplay: boolean
) {
  return {
    order: {
      id: order.id,
      orderNo: order.orderNo,
      serviceOptionId: order.serviceOptionId
    },
    account: {
      id: account.id,
      appleIdMasked: account.appleIdMasked,
      currentBalance: account.currentBalance.toString(),
      balanceCostAmount: account.balanceCostAmount.toString()
    },
    lock: toLockSummary(lock),
    idempotentReplay
  };
}

export function toLockSummary(lock: {
  id: string;
  serviceOptionId: string | null;
  lockScope: IdBusinessV2AccountLockScope;
  status: string;
  lockedAt: Date;
  expiresAt: Date;
  endedAt?: Date | null;
  endReason?: string | null;
  reason: string | null;
}) {
  return {
    id: lock.id,
    serviceOptionId: lock.serviceOptionId,
    lockScope: lock.lockScope,
    status: lock.status,
    lockedAt: lock.lockedAt,
    expiresAt: lock.expiresAt,
    endedAt: lock.endedAt ?? null,
    endReason: lock.endReason ?? null,
    reason: lock.reason
  };
}

export function normalizeReservationInput(input: ReserveAccountForOrderInput) {
  return {
    orderId: normalizeUuid(input.orderId, '订单'),
    accountId: normalizeUuid(input.accountId, 'ID'),
    expiresAt: normalizeFutureDate(input.expiresAt, '锁定到期时间'),
    lockScope: normalizeLockScope(input.lockScope),
    reason: normalizeOptionalReason(input.reason)
  };
}

export function normalizeUuid(value: unknown, label: string) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!UUID_PATTERN.test(normalized)) {
    throw new BadRequestException(`${label}格式无效`);
  }
  return normalized;
}

function normalizeFutureDate(value: unknown, label: string) {
  const date =
    value instanceof Date
      ? new Date(value.getTime())
      : typeof value === 'string'
        ? new Date(value)
        : new Date(Number.NaN);
  if (Number.isNaN(date.getTime()) || date.getTime() <= Date.now()) {
    throw new BadRequestException(`${label}必须是未来的有效时间`);
  }
  return date;
}

function normalizeLockScope(value: unknown): IdBusinessV2AccountLockScope {
  if (value === undefined || value === null || value === '') {
    return 'by_service';
  }
  if (value === 'by_service' || value === 'global') {
    return value;
  }
  throw new BadRequestException('锁定范围无效');
}

function normalizeOptionalReason(value: unknown) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    throw new BadRequestException('锁定原因格式无效');
  }
  const normalized = value.trim();
  if (normalized.length > 500) {
    throw new BadRequestException('锁定原因不能超过 500 个字符');
  }
  return normalized || null;
}

export function normalizeRequiredReason(value: unknown, label: string) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (normalized.length < 2 || normalized.length > 500) {
    throw new BadRequestException(`${label}必须为 2 至 500 个字符`);
  }
  return normalized;
}

export function normalizeIdempotencyKey(value: unknown) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!IDEMPOTENCY_KEY_PATTERN.test(normalized)) {
    throw new BadRequestException('幂等键必须是 8 至 100 位字母、数字或 ._:-');
  }
  return normalized;
}

export function buildConsumptionIdempotencyKey(orderId: string, value: string) {
  return `order_consumption:${orderId}:${value}`;
}

export function isUniqueConstraintError(error: unknown) {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'P2002'
  );
}
