import { BadRequestException, ConflictException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { AuthenticatedUser } from '../../auth/auth.types';
import type { CreateIdBusinessV2OrderDto } from './dto/create-id-business-v2-order.dto';
import {
  Amount4,
  Rate8,
  V2_DECIMAL_PATTERN,
  V2_DECIMAL_PLACES,
  toIdBusinessV2BusinessDate,
  type V2CommandTransaction,
  type V2DecimalInput
} from '../runtime/public-api';
import type {
  IdBusinessV2AccountLockRecord,
  IdBusinessV2AccountLockScope,
  IdBusinessV2OrderAccountDisposition,
  IdBusinessV2OrderAccountSource,
  IdBusinessV2OrderRecord
} from './id-business-v2-order.types';
import type { IdBusinessV2OrdersRepository } from './persistence/id-business-v2-orders.repository';

export interface NormalizedCreateOrderInput {
  customerId: string;
  serviceOptionId: string;
  accountId: string;
  accountSource: IdBusinessV2OrderAccountSource;
  accountDisposition: IdBusinessV2OrderAccountDisposition;
  settlementPlatformOptionId: string;
  platformOrderNo: string | null;
  websiteAccount: string | null;
  websiteAccountHash: string | null;
  receivedAmount: Amount4;
  balanceAmount: Amount4;
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
const MAX_AMOUNT = Amount4.from('99999999999999.9999');

export function normalizeCreateOrderInput(
  dto: CreateIdBusinessV2OrderDto,
  hash: (value: string | null) => string | null
): NormalizedCreateOrderInput {
  const customerId = normalizeUuid(dto.customerId, '客户');
  const serviceOptionId = normalizeUuid(dto.serviceOptionId, '业务');
  const accountId = normalizeUuid(dto.accountId, '使用 ID');
  const accountSource = normalizeAccountSource(dto.accountSource);
  const accountDisposition =
    accountSource === 'customer_owned'
      ? 'retained'
      : normalizeAccountDisposition(dto.accountDisposition);
  const settlementPlatformOptionId = normalizeUuid(dto.settlementPlatformOptionId, '结算平台');
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
    accountSource,
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
      accountSource === 'customer_owned'
        ? 'by_service'
        : accountDisposition === 'sold'
          ? 'global'
          : normalizeLockScope(dto.lockScope),
    idempotencyKey: buildIdempotencyKey(normalizeIdempotencyKey(dto.idempotencyKey)),
    remark: normalizeOptionalString(dto.remark, '备注', 2000)
  };
}

export function calculatePlatformFee(
  receivedAmount: V2DecimalInput,
  platform: {
    fixedFee: V2DecimalInput;
    percentageFee: V2DecimalInput;
  } | null
) {
  if (!platform) return Amount4.zero();
  const normalizedReceivedAmount = Amount4.from(receivedAmount);
  const percentage = Rate8.from(platform.percentageFee).div(100);
  const platformFeeAmount = Amount4.from(platform.fixedFee).add(
    percentage.apply(normalizedReceivedAmount)
  );
  if (platformFeeAmount.gt(MAX_AMOUNT)) {
    throw new BadRequestException('平台手续费数值过大');
  }
  return platformFeeAmount;
}

export function assertOrderEntryReplayMatches(
  order: IdBusinessV2OrderRecord,
  lock: IdBusinessV2AccountLockRecord | null,
  input: NormalizedCreateOrderInput
) {
  if (order.deletedAt) {
    throw new ConflictException('该幂等请求对应的订单已经删除，不能重新创建');
  }
  if (
    order.customerId !== input.customerId ||
    order.serviceOptionId !== input.serviceOptionId ||
    order.accountId !== input.accountId ||
    order.accountSource !== input.accountSource ||
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
  tx: V2CommandTransaction,
  repository: IdBusinessV2OrdersRepository,
  order: IdBusinessV2OrderRecord,
  input: NormalizedCreateOrderInput,
  platformFeeAmount: Amount4,
  lock: {
    id: string;
    lockScope: IdBusinessV2AccountLockScope;
    expiresAt: Date;
  },
  operator?: AuthenticatedUser
) {
  await repository.appendAudit(tx, {
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
      accountSource: input.accountSource,
      sourceSoldOrderId: order.sourceSoldOrderId,
      accountDisposition: input.accountDisposition,
      accountCostAmount: order.accountCostAmount.toString(),
      appliedAccountCostAmount: order.appliedAccountCostAmount.toString(),
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
  });
}

export function toOrderEntryLockSummary(
  lock: IdBusinessV2AccountLockRecord | null
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
  const day = toIdBusinessV2BusinessDate(new Date()).text.replaceAll('-', '');
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

function normalizeAmount(value: unknown, label: string, allowZero: boolean) {
  const normalized =
    typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
  if (!V2_DECIMAL_PATTERN.test(normalized)) {
    throw new BadRequestException(`${label}必须是最多 ${V2_DECIMAL_PLACES} 位小数的非负数`);
  }
  const amount = Amount4.from(normalized);
  if ((!allowZero && amount.lte(0)) || (allowZero && amount.lt(0))) {
    throw new BadRequestException(`${label}${allowZero ? '不能为负数' : '必须大于 0'}`);
  }
  if (amount.gt(MAX_AMOUNT)) throw new BadRequestException(`${label}数值过大`);
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
    return 'by_service';
  }
  if (value === 'by_service' || value === 'global') {
    return value;
  }
  throw new BadRequestException('锁定范围无效');
}

function normalizeAccountDisposition(value: unknown): IdBusinessV2OrderAccountDisposition {
  if (value === 'retained') {
    return 'retained';
  }
  if (value === 'sold') {
    return 'sold';
  }
  throw new BadRequestException('ID 处理方式必须选择保留或卖出');
}

function normalizeAccountSource(value: unknown): IdBusinessV2OrderAccountSource {
  if (value === undefined || value === null || value === '' || value === 'inventory') {
    return 'inventory';
  }
  if (value === 'customer_owned') return value;
  throw new BadRequestException('ID 来源无效');
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
