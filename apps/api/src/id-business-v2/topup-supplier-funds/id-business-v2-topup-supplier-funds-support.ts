import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException
} from '@nestjs/common';
import { Prisma as PrismaNamespace } from '@prisma/client';
import type { Prisma } from '@prisma/client';
import type { AuthenticatedUser } from '../../auth/auth.types';
import { PrismaService } from '../../common/prisma/prisma.service';
import {
  roundV2Decimal,
  toV2Decimal,
  toV2DecimalString,
  V2_DECIMAL_ROUNDING_MODE
} from '../decimal-policy';

export interface LockedSupplierAccountRow {
  id: string;
  supplierOptionId: string;
  supplierName: string;
  currency: 'CNY' | 'MYR' | 'USDT';
  currentBalance: PrismaNamespace.Decimal;
  currentBalanceCny: PrismaNamespace.Decimal;
  initializedAt: Date | null;
}

type RawLockedSupplierAccountRow = Omit<
  LockedSupplierAccountRow,
  'currentBalance' | 'currentBalanceCny'
> & {
  currentBalance: PrismaNamespace.Decimal.Value;
  currentBalanceCny: PrismaNamespace.Decimal.Value;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,100}$/;
const SIGNED_AMOUNT_PATTERN = /^-?(?:0|[1-9]\d{0,13})(?:\.\d{1,4})?$/;
const UNSIGNED_AMOUNT_PATTERN = /^(?:0|[1-9]\d{0,13})(?:\.\d{1,4})?$/;
const RATE_PATTERN = /^(?:0|[1-9]\d{0,9})(?:\.\d{1,8})?$/;

export abstract class IdBusinessV2TopupSupplierFundsSupport {
  protected constructor(protected readonly prisma: PrismaService) {}

  protected async requireSupplierOption(tx: Prisma.TransactionClient, supplierOptionId: string) {
    const supplier = await tx.idBusinessV2Option.findFirst({
      where: {
        id: supplierOptionId,
        type: 'topup_supplier',
        status: 'active',
        deletedAt: null
      },
      select: { id: true, code: true, name: true }
    });
    if (!supplier) throw new BadRequestException('加卡供应商不存在或已停用');
    return supplier;
  }

  protected async lockSupplierAccount(tx: Prisma.TransactionClient, supplierOptionId: string) {
    const rows = await tx.$queryRaw<RawLockedSupplierAccountRow[]>(PrismaNamespace.sql`
      SELECT
        account."id",
        account."supplier_option_id" AS "supplierOptionId",
        supplier."name" AS "supplierName",
        account."currency",
        account."current_balance" AS "currentBalance",
        account."current_balance_cny" AS "currentBalanceCny",
        account."initialized_at" AS "initializedAt"
      FROM "id_business_v2_topup_supplier_accounts" account
      INNER JOIN "id_business_v2_options" supplier
        ON supplier."id" = account."supplier_option_id"
      WHERE
        account."supplier_option_id" = CAST(${supplierOptionId} AS UUID)
        AND account."currency" = 'CNY'
        AND supplier."type" = 'topup_supplier'
        AND supplier."status" = 'active'
        AND supplier."deleted_at" IS NULL
      FOR UPDATE OF account
    `);
    if (!rows[0]) {
      const supplier = await this.requireSupplierOption(tx, supplierOptionId);
      throw new ConflictException(`供应商“${supplier.name}”资金账户尚未初始化`);
    }
    return this.normalizeLockedSupplierAccount(rows[0]);
  }

  protected async lockSupplierAccountById(tx: Prisma.TransactionClient, accountId: string) {
    const rows = await tx.$queryRaw<RawLockedSupplierAccountRow[]>(PrismaNamespace.sql`
      SELECT
        account."id",
        account."supplier_option_id" AS "supplierOptionId",
        supplier."name" AS "supplierName",
        account."currency",
        account."current_balance" AS "currentBalance",
        account."current_balance_cny" AS "currentBalanceCny",
        account."initialized_at" AS "initializedAt"
      FROM "id_business_v2_topup_supplier_accounts" account
      INNER JOIN "id_business_v2_options" supplier
        ON supplier."id" = account."supplier_option_id"
      WHERE
        account."id" = CAST(${accountId} AS UUID)
      FOR UPDATE OF account
    `);
    if (!rows[0]) throw new NotFoundException('供应商资金账户不存在');
    return this.normalizeLockedSupplierAccount(rows[0]);
  }

  protected async lockSupplierAccountsByIds(tx: Prisma.TransactionClient, accountIds: string[]) {
    const uniqueIds = [...new Set(accountIds)].sort();
    const rows = await tx.$queryRaw<RawLockedSupplierAccountRow[]>(PrismaNamespace.sql`
      SELECT
        account."id",
        account."supplier_option_id" AS "supplierOptionId",
        supplier."name" AS "supplierName",
        account."currency",
        account."current_balance" AS "currentBalance",
        account."current_balance_cny" AS "currentBalanceCny",
        account."initialized_at" AS "initializedAt"
      FROM "id_business_v2_topup_supplier_accounts" account
      INNER JOIN "id_business_v2_options" supplier
        ON supplier."id" = account."supplier_option_id"
      WHERE
        account."id" IN (${PrismaNamespace.join(uniqueIds.map((id) => PrismaNamespace.sql`CAST(${id} AS UUID)`))})
        AND account."currency" = 'CNY'
      ORDER BY account."id"
      FOR UPDATE OF account
    `);
    return new Map(
      rows.map((row) => {
        const normalized = this.normalizeLockedSupplierAccount(row);
        return [normalized.id, normalized];
      })
    );
  }

  private normalizeLockedSupplierAccount(
    row: RawLockedSupplierAccountRow
  ): LockedSupplierAccountRow {
    return {
      ...row,
      currentBalance: toV2Decimal(row.currentBalance),
      currentBalanceCny: toV2Decimal(row.currentBalanceCny)
    };
  }

  protected assertInitialized(account: LockedSupplierAccountRow) {
    if (!account.initializedAt) {
      throw new ConflictException(`供应商“${account.supplierName}”资金账户尚未初始化`);
    }
  }

  protected assertFundManagementPermission(operator?: AuthenticatedUser) {
    if (
      !operator ||
      (!operator.roles.includes('admin') &&
        !operator.permissions.includes('apple.topup_supplier_fund.manage'))
    ) {
      throw new ForbiddenException('无权管理加卡供应商资金');
    }
  }

  protected cnyLedgerAmounts(
    amount: PrismaNamespace.Decimal.Value,
    balanceBefore: PrismaNamespace.Decimal.Value,
    balanceAfter: PrismaNamespace.Decimal.Value
  ) {
    const normalizedAmount = roundV2Decimal(amount);
    const normalizedBefore = roundV2Decimal(balanceBefore);
    const normalizedAfter = roundV2Decimal(balanceAfter);
    return {
      currency: 'CNY' as const,
      amount: normalizedAmount,
      balanceBefore: normalizedBefore,
      balanceAfter: normalizedAfter,
      amountCny: normalizedAmount,
      balanceBeforeCny: normalizedBefore,
      balanceAfterCny: normalizedAfter
    };
  }

  protected normalizeUuid(value: unknown, label: string) {
    const normalized = typeof value === 'string' ? value.trim() : '';
    if (!UUID_PATTERN.test(normalized)) throw new BadRequestException(`${label}格式无效`);
    return normalized;
  }

  protected normalizeSignedAmount(value: unknown, label: string) {
    const normalized = String(value ?? '').trim();
    if (!SIGNED_AMOUNT_PATTERN.test(normalized)) {
      throw new BadRequestException(`${label}必须是最多 4 位小数的有效金额`);
    }
    return roundV2Decimal(normalized);
  }

  protected normalizeUnsignedAmount(value: unknown, label: string, allowZero: boolean) {
    const normalized = String(value ?? '').trim();
    if (!UNSIGNED_AMOUNT_PATTERN.test(normalized)) {
      throw new BadRequestException(`${label}必须是最多 4 位小数的有效金额`);
    }
    const decimal = roundV2Decimal(normalized);
    if (allowZero ? decimal.lt(0) : decimal.lte(0)) {
      throw new BadRequestException(`${label}${allowZero ? '不能小于 0' : '必须大于 0'}`);
    }
    return decimal;
  }

  protected normalizeRate(value: unknown) {
    const normalized = String(value ?? '').trim();
    if (!RATE_PATTERN.test(normalized)) {
      throw new BadRequestException('结算汇率必须是最多 8 位小数的正数');
    }
    const rate = toV2Decimal(normalized).toDecimalPlaces(8, V2_DECIMAL_ROUNDING_MODE);
    if (rate.lte(0)) throw new BadRequestException('结算汇率必须大于 0');
    return rate;
  }

  protected normalizeDate(value: unknown, label: string) {
    if (typeof value !== 'string' || !value.trim()) {
      throw new BadRequestException(`${label}不能为空`);
    }
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) throw new BadRequestException(`${label}格式无效`);
    return date;
  }

  protected normalizeReason(value: unknown) {
    const normalized = typeof value === 'string' ? value.trim() : '';
    if (normalized.length < 2 || normalized.length > 500) {
      throw new BadRequestException('操作原因必须为 2 至 500 个字符');
    }
    return normalized;
  }

  protected normalizeOptionalText(value: unknown, label: string, maximumLength: number) {
    if (value === undefined || value === null) return null;
    if (typeof value !== 'string') throw new BadRequestException(`${label}格式无效`);
    const normalized = value.trim();
    if (!normalized) return null;
    if (normalized.length > maximumLength) {
      throw new BadRequestException(`${label}不能超过 ${maximumLength} 个字符`);
    }
    return normalized;
  }

  protected normalizeIdempotencyKey(value: unknown) {
    const normalized = typeof value === 'string' ? value.trim() : '';
    if (!IDEMPOTENCY_KEY_PATTERN.test(normalized)) {
      throw new BadRequestException('幂等键必须是 8 至 100 位字母、数字或 ._:-');
    }
    return normalized;
  }

  protected buildIdempotencyKey(prefix: string, objectId: string, value: unknown) {
    return `${prefix}:${objectId}:${this.normalizeIdempotencyKey(value)}`;
  }

  protected assertLedgerReplay(
    replay: {
      entryType: string;
      balanceAfterCny: PrismaNamespace.Decimal;
      reason: string | null;
    },
    expected: {
      entryType: string;
      balanceAfter?: PrismaNamespace.Decimal;
      reason: string;
    }
  ) {
    const balanceAfterCny = toV2Decimal(replay.balanceAfterCny);
    if (
      replay.entryType !== expected.entryType ||
      (expected.balanceAfter && !balanceAfterCny.eq(expected.balanceAfter)) ||
      replay.reason !== expected.reason
    ) {
      throw new ConflictException('幂等键已用于不同的供应商资金操作');
    }
  }

  protected assertPaymentReplay(
    replay: {
      receivedUsdt: PrismaNamespace.Decimal | null;
      networkFeeUsdt: PrismaNamespace.Decimal | null;
      settlementRateCnyUsdt: PrismaNamespace.Decimal | null;
      paidAmount: PrismaNamespace.Decimal;
      networkFeeAmount: PrismaNamespace.Decimal;
      fxRateToCny: PrismaNamespace.Decimal;
      paidAt: Date;
      network: string | null;
      transactionHash: string | null;
      remark: string | null;
    },
    expected: {
      receivedUsdt: PrismaNamespace.Decimal;
      networkFeeUsdt: PrismaNamespace.Decimal;
      settlementRate: PrismaNamespace.Decimal;
      paidAt: Date;
      network: string | null;
      transactionHash: string | null;
      remark: string | null;
    }
  ) {
    const receivedUsdt = toV2Decimal(replay.receivedUsdt ?? replay.paidAmount);
    const networkFeeUsdt = toV2Decimal(replay.networkFeeUsdt ?? replay.networkFeeAmount);
    const settlementRate = toV2Decimal(replay.settlementRateCnyUsdt ?? replay.fxRateToCny);
    if (
      !receivedUsdt.eq(expected.receivedUsdt) ||
      !networkFeeUsdt.eq(expected.networkFeeUsdt) ||
      !settlementRate.eq(expected.settlementRate) ||
      replay.paidAt.getTime() !== expected.paidAt.getTime() ||
      replay.network !== expected.network ||
      replay.transactionHash !== expected.transactionHash ||
      replay.remark !== expected.remark
    ) {
      throw new ConflictException('幂等键已用于不同的付款内容');
    }
  }

  protected toFundMutationResponse(
    entry: {
      id: string;
      entryType: string;
      amountCny: PrismaNamespace.Decimal;
      balanceBeforeCny: PrismaNamespace.Decimal;
      balanceAfterCny: PrismaNamespace.Decimal;
      createdAt: Date;
      supplierAccount: {
        supplierOptionId: string;
        supplierOption: { id: string; name: string };
      };
    },
    idempotentReplay: boolean
  ) {
    return {
      supplier: {
        id: entry.supplierAccount.supplierOption.id,
        name: entry.supplierAccount.supplierOption.name
      },
      ledgerEntry: {
        id: entry.id,
        entryType: entry.entryType,
        amountCny: toV2DecimalString(entry.amountCny),
        balanceBeforeCny: toV2DecimalString(entry.balanceBeforeCny),
        balanceAfterCny: toV2DecimalString(entry.balanceAfterCny),
        isNegative: entry.balanceAfterCny.lt(0),
        createdAt: entry.createdAt
      },
      idempotentReplay
    };
  }

  protected toPaymentMutationResponse(
    payment: {
      id: string;
      receivedUsdt: PrismaNamespace.Decimal | null;
      networkFeeUsdt: PrismaNamespace.Decimal | null;
      settlementRateCnyUsdt: PrismaNamespace.Decimal | null;
      paidAmount: PrismaNamespace.Decimal;
      networkFeeAmount: PrismaNamespace.Decimal;
      fxRateToCny: PrismaNamespace.Decimal;
      creditedCny: PrismaNamespace.Decimal;
      paidAt: Date;
      createdAt: Date;
      supplierAccount: {
        supplierOption: { id: string; name: string };
      };
      ledgerEntries: Array<{
        id: string;
        balanceBeforeCny: PrismaNamespace.Decimal;
        balanceAfterCny: PrismaNamespace.Decimal;
        createdAt: Date;
      }>;
    },
    idempotentReplay: boolean
  ) {
    const ledgerEntry = payment.ledgerEntries[0];
    if (!ledgerEntry) throw new ConflictException('付款缺少资金流水');
    const receivedUsdt = payment.receivedUsdt ?? payment.paidAmount;
    const networkFeeUsdt = payment.networkFeeUsdt ?? payment.networkFeeAmount;
    const settlementRate = payment.settlementRateCnyUsdt ?? payment.fxRateToCny;
    return {
      payment: {
        id: payment.id,
        supplier: payment.supplierAccount.supplierOption,
        receivedUsdt: toV2DecimalString(receivedUsdt),
        networkFeeUsdt: toV2DecimalString(networkFeeUsdt),
        settlementRateCnyUsdt: settlementRate.toString(),
        creditedCny: toV2DecimalString(payment.creditedCny),
        paidAt: payment.paidAt,
        createdAt: payment.createdAt
      },
      ledgerEntry: {
        id: ledgerEntry.id,
        balanceBeforeCny: toV2DecimalString(ledgerEntry.balanceBeforeCny),
        balanceAfterCny: toV2DecimalString(ledgerEntry.balanceAfterCny),
        isNegative: ledgerEntry.balanceAfterCny.lt(0),
        createdAt: ledgerEntry.createdAt
      },
      idempotentReplay
    };
  }

  protected toSupplierSnapshot(
    entry: {
      id: string;
      supplierAccountId: string;
      amountCny: PrismaNamespace.Decimal;
      balanceBeforeCny: PrismaNamespace.Decimal;
      balanceAfterCny: PrismaNamespace.Decimal;
      supplierNameSnapshot: string;
      createdAt: Date;
    },
    idempotentReplay: boolean
  ) {
    return {
      ledgerEntryId: entry.id,
      supplierAccountId: entry.supplierAccountId,
      supplierName: entry.supplierNameSnapshot,
      amountCny: toV2DecimalString(entry.amountCny),
      balanceBeforeCny: toV2DecimalString(entry.balanceBeforeCny),
      balanceAfterCny: toV2DecimalString(entry.balanceAfterCny),
      isNegative: entry.balanceAfterCny.lt(0),
      shortfallCny: entry.balanceAfterCny.lt(0)
        ? toV2DecimalString(entry.balanceAfterCny.abs())
        : '0',
      createdAt: entry.createdAt,
      idempotentReplay
    };
  }

  protected async writeAudit(
    tx: Prisma.TransactionClient,
    input: {
      operator?: AuthenticatedUser;
      action: string;
      objectType: string;
      objectId: string;
      beforeData?: Prisma.InputJsonValue;
      afterData?: Prisma.InputJsonValue;
      remark: string;
    }
  ) {
    await tx.auditLog.create({
      data: {
        userId: input.operator?.id,
        module: 'id_business_v2',
        action: input.action,
        objectType: input.objectType,
        objectId: input.objectId,
        beforeData: input.beforeData,
        afterData: input.afterData,
        remark: input.remark
      }
    });
  }
}
