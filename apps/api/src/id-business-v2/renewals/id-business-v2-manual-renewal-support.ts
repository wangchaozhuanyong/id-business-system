import { BadRequestException, ConflictException } from '@nestjs/common';
import { Prisma as PrismaNamespace } from '@prisma/client';
import type { Prisma } from '@prisma/client';
import type { CreateIdBusinessV2ManualRenewalDto } from './dto/create-id-business-v2-manual-renewal.dto';

export interface NormalizedManualRenewal {
  serviceOptionId: string;
  settlementPlatformOptionId: string | null;
  platformOrderNo: string | null;
  receivedAmount: PrismaNamespace.Decimal;
  balanceAmount: PrismaNamespace.Decimal;
  openedAt: Date;
  dueAt: Date;
  idempotencyKey: string;
  remark: string | null;
}

export const MANUAL_RENEWAL_REPLAY_INCLUDE = {
  activation: true,
  balanceLedger: {
    where: {
      entryType: 'order_consumption' as const
    },
    take: 1,
    orderBy: {
      createdAt: 'asc' as const
    }
  }
} satisfies Prisma.IdBusinessV2OrderInclude;

export type ManualRenewalReplayOrder = Prisma.IdBusinessV2OrderGetPayload<{
  include: typeof MANUAL_RENEWAL_REPLAY_INCLUDE;
}>;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,100}$/;
const DECIMAL_PATTERN = /^\d+(\.\d{1,4})?$/;
const MAX_AMOUNT = new PrismaNamespace.Decimal('99999999999999.9999');

export function normalizeManualRenewalInput(
  activationId: string,
  dto: CreateIdBusinessV2ManualRenewalDto
): NormalizedManualRenewal {
  const serviceOptionId = normalizeUuid(dto.serviceOptionId, '续费业务');
  const settlementPlatformOptionId = normalizeOptionalUuid(
    dto.settlementPlatformOptionId,
    '结算平台'
  );
  const platformOrderNo = normalizeOptionalString(dto.platformOrderNo, '平台订单号', 160);
  if (platformOrderNo && !settlementPlatformOptionId) {
    throw new BadRequestException('填写平台订单号时必须选择结算平台');
  }
  const receivedAmount = normalizeAmount(dto.receivedAmount, '实收金额', true);
  const balanceAmount = normalizeAmount(dto.balanceAmount, '消耗余额', false);
  const openedAt = normalizeDate(dto.openedAt, '续费开始时间');
  const dueAt = normalizeDate(dto.dueAt, '续费到期时间');
  if (dueAt.getTime() <= openedAt.getTime()) {
    throw new BadRequestException('续费到期时间必须晚于开始时间');
  }
  if (dueAt.getTime() <= Date.now()) {
    throw new BadRequestException('续费到期时间必须晚于当前时间');
  }
  return {
    serviceOptionId,
    settlementPlatformOptionId,
    platformOrderNo,
    receivedAmount,
    balanceAmount,
    openedAt,
    dueAt,
    idempotencyKey: `manual_renewal:${activationId}:${normalizeIdempotencyKey(dto.idempotencyKey)}`,
    remark: normalizeOptionalString(dto.remark, '备注', 2000)
  };
}

export function buildManualRenewalReplayResult(
  order: ManualRenewalReplayOrder,
  input: NormalizedManualRenewal
) {
  const activation = order.activation;
  const ledgerEntry = order.balanceLedger[0];
  assertReplayMatches(order, activation, ledgerEntry, input);
  return {
    orderId: order.id,
    activation: activation!,
    ledgerEntry: ledgerEntry!,
    profitAmount: order.profitAmount!,
    idempotentReplay: true
  };
}

function assertReplayMatches(
  order: ManualRenewalReplayOrder,
  activation: ManualRenewalReplayOrder['activation'],
  ledgerEntry: ManualRenewalReplayOrder['balanceLedger'][number] | undefined,
  input: NormalizedManualRenewal
) {
  const commonFieldsMatch =
    order.serviceOptionId === input.serviceOptionId &&
    order.settlementPlatformOptionId === input.settlementPlatformOptionId &&
    order.platformOrderNo === input.platformOrderNo &&
    order.receivedAmount.equals(input.receivedAmount) &&
    order.balanceAmount.equals(input.balanceAmount) &&
    order.openedAt?.getTime() === input.openedAt.getTime() &&
    order.dueAt?.getTime() === input.dueAt.getTime() &&
    order.remark === input.remark;
  const completionEvidenceValid =
    order.status === 'completed' &&
    !order.deletedAt &&
    order.profitAmount !== null &&
    activation !== null &&
    activation.orderId === order.id &&
    activation.customerId === order.customerId &&
    activation.accountId === order.accountId &&
    activation.serviceOptionId === order.serviceOptionId &&
    ledgerEntry !== undefined &&
    ledgerEntry.orderId === order.id &&
    ledgerEntry.accountId === order.accountId &&
    ledgerEntry.entryType === 'order_consumption' &&
    ledgerEntry.direction === 'debit' &&
    ledgerEntry.balanceAmount.equals(order.balanceAmount) &&
    ledgerEntry.costAmount.equals(order.balanceCostAmount);
  if (!commonFieldsMatch) {
    throw new ConflictException('幂等键已用于其他手工续费内容，请刷新后重新提交');
  }
  if (!completionEvidenceValid) {
    throw new ConflictException('续费订单缺少完整扣款或开通证据，请人工核对');
  }
}

export function normalizeUuid(value: unknown, label: string) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!UUID_PATTERN.test(normalized)) throw new BadRequestException(`${label}格式无效`);
  return normalized;
}

export function toManualRenewalLedgerResponse(entry: {
  id: string;
  accountId: string;
  balanceAmount: PrismaNamespace.Decimal;
  costAmount: PrismaNamespace.Decimal;
  balanceBefore: PrismaNamespace.Decimal;
  balanceAfter: PrismaNamespace.Decimal;
  costBefore: PrismaNamespace.Decimal;
  costAfter: PrismaNamespace.Decimal;
  averageCostBefore: PrismaNamespace.Decimal;
  averageCostAfter: PrismaNamespace.Decimal;
  createdAt: Date;
}) {
  return {
    id: entry.id,
    accountId: entry.accountId,
    balanceAmount: entry.balanceAmount.toString(),
    costAmount: entry.costAmount.toString(),
    balanceBefore: entry.balanceBefore.toString(),
    balanceAfter: entry.balanceAfter.toString(),
    costBefore: entry.costBefore.toString(),
    costAfter: entry.costAfter.toString(),
    averageCostBefore: entry.averageCostBefore.toString(),
    averageCostAfter: entry.averageCostAfter.toString(),
    createdAt: entry.createdAt
  };
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

function normalizeOptionalString(value: unknown, label: string, maxLength: number) {
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

function normalizeAmount(value: unknown, label: string, allowZero: boolean) {
  const normalized =
    typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
  if (!DECIMAL_PATTERN.test(normalized)) {
    throw new BadRequestException(`${label}必须是最多 4 位小数的非负数`);
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

function normalizeIdempotencyKey(value: unknown) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!IDEMPOTENCY_KEY_PATTERN.test(normalized)) {
    throw new BadRequestException('幂等键必须是 8 至 100 位字母、数字或 ._:-');
  }
  return normalized;
}
