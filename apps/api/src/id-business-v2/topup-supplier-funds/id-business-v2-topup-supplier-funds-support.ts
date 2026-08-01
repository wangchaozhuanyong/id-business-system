import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException
} from '@nestjs/common';
import type { AuthenticatedUser } from '../../auth/auth.types';
import {
  Amount4,
  Rate8,
  V2TransactionalAuditService,
  toV2JsonDocument,
  type V2CommandTransaction,
  type V2DecimalInput,
  type V2JsonDocument
} from '../runtime/public-api';
import { type LockedSupplierAccountRow } from './persistence/id-business-v2-topup-supplier-account.repository';
import { IdBusinessV2TopupSupplierCommandRepository } from './persistence/id-business-v2-topup-supplier-command.repository';

export type { LockedSupplierAccountRow } from './persistence/id-business-v2-topup-supplier-account.repository';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,100}$/;
const SIGNED_AMOUNT_PATTERN = /^-?(?:0|[1-9]\d{0,13})(?:\.\d{1,4})?$/;
const UNSIGNED_AMOUNT_PATTERN = /^(?:0|[1-9]\d{0,13})(?:\.\d{1,4})?$/;
const RATE_PATTERN = /^(?:0|[1-9]\d{0,9})(?:\.\d{1,8})?$/;

export abstract class IdBusinessV2TopupSupplierFundsSupport {
  protected constructor(
    protected readonly repository: IdBusinessV2TopupSupplierCommandRepository,
    private readonly transactionalAudit: V2TransactionalAuditService
  ) {}

  protected async requireSupplierOption(tx: V2CommandTransaction, supplierOptionId: string) {
    const supplier = await this.repository.findActiveSupplier(tx, supplierOptionId);
    if (!supplier) throw new BadRequestException('加卡供应商不存在或已停用');
    return supplier;
  }

  protected async lockSupplierAccount(tx: V2CommandTransaction, supplierOptionId: string) {
    const account = await this.repository.lockSupplierAccount(tx, supplierOptionId);
    if (!account) {
      const supplier = await this.requireSupplierOption(tx, supplierOptionId);
      throw new ConflictException(`供应商“${supplier.name}”资金账户尚未初始化`);
    }
    return account;
  }

  protected async lockSupplierAccountById(tx: V2CommandTransaction, accountId: string) {
    const account = await this.repository.lockSupplierAccountById(tx, accountId);
    if (!account) throw new NotFoundException('供应商资金账户不存在');
    return account;
  }

  protected lockSupplierAccountsByIds(tx: V2CommandTransaction, accountIds: string[]) {
    return this.repository.lockSupplierAccountsByIds(tx, accountIds);
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
    amount: V2DecimalInput,
    balanceBefore: V2DecimalInput,
    balanceAfter: V2DecimalInput
  ) {
    const normalizedAmount = Amount4.from(amount).toString();
    const normalizedBefore = Amount4.from(balanceBefore).toString();
    const normalizedAfter = Amount4.from(balanceAfter).toString();
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
    return Amount4.from(normalized);
  }

  protected normalizeUnsignedAmount(value: unknown, label: string, allowZero: boolean) {
    const normalized = String(value ?? '').trim();
    if (!UNSIGNED_AMOUNT_PATTERN.test(normalized)) {
      throw new BadRequestException(`${label}必须是最多 4 位小数的有效金额`);
    }
    const decimal = Amount4.from(normalized);
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
    const rate = Rate8.from(normalized);
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
      balanceAfterCny: Amount4;
      reason: string | null;
    },
    expected: {
      entryType: string;
      balanceAfter?: Amount4;
      reason: string;
    }
  ) {
    if (
      replay.entryType !== expected.entryType ||
      (expected.balanceAfter && !replay.balanceAfterCny.equals(expected.balanceAfter)) ||
      replay.reason !== expected.reason
    ) {
      throw new ConflictException('幂等键已用于不同的供应商资金操作');
    }
  }

  protected assertPaymentReplay(
    replay: {
      receivedUsdt: Amount4 | null;
      networkFeeUsdt: Amount4 | null;
      settlementRateCnyUsdt: Rate8 | null;
      paidAmount: Amount4;
      networkFeeAmount: Amount4;
      fxRateToCny: Rate8;
      paidAt: Date;
      network: string | null;
      transactionHash: string | null;
      remark: string | null;
    },
    expected: {
      receivedUsdt: Amount4;
      networkFeeUsdt: Amount4;
      settlementRate: Rate8;
      paidAt: Date;
      network: string | null;
      transactionHash: string | null;
      remark: string | null;
    }
  ) {
    const receivedUsdt = replay.receivedUsdt ?? replay.paidAmount;
    const networkFeeUsdt = replay.networkFeeUsdt ?? replay.networkFeeAmount;
    const settlementRate = replay.settlementRateCnyUsdt ?? replay.fxRateToCny;
    if (
      !receivedUsdt.equals(expected.receivedUsdt) ||
      !networkFeeUsdt.equals(expected.networkFeeUsdt) ||
      !settlementRate.equals(expected.settlementRate) ||
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
      amountCny: Amount4;
      balanceBeforeCny: Amount4;
      balanceAfterCny: Amount4;
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
        amountCny: entry.amountCny.toString(),
        balanceBeforeCny: entry.balanceBeforeCny.toString(),
        balanceAfterCny: entry.balanceAfterCny.toString(),
        isNegative: entry.balanceAfterCny.isNegative(),
        createdAt: entry.createdAt
      },
      idempotentReplay
    };
  }

  protected toPaymentMutationResponse(
    payment: {
      id: string;
      receivedUsdt: Amount4 | null;
      networkFeeUsdt: Amount4 | null;
      settlementRateCnyUsdt: Rate8 | null;
      paidAmount: Amount4;
      networkFeeAmount: Amount4;
      fxRateToCny: Rate8;
      creditedCny: Amount4;
      paidAt: Date;
      createdAt: Date;
      supplierAccount: {
        supplierOption: { id: string; name: string };
      };
      ledgerEntries: Array<{
        id: string;
        balanceBeforeCny: Amount4;
        balanceAfterCny: Amount4;
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
        receivedUsdt: receivedUsdt.toString(),
        networkFeeUsdt: networkFeeUsdt.toString(),
        settlementRateCnyUsdt: settlementRate.toString(),
        creditedCny: payment.creditedCny.toString(),
        paidAt: payment.paidAt,
        createdAt: payment.createdAt
      },
      ledgerEntry: {
        id: ledgerEntry.id,
        balanceBeforeCny: ledgerEntry.balanceBeforeCny.toString(),
        balanceAfterCny: ledgerEntry.balanceAfterCny.toString(),
        isNegative: ledgerEntry.balanceAfterCny.isNegative(),
        createdAt: ledgerEntry.createdAt
      },
      idempotentReplay
    };
  }

  protected toSupplierSnapshot(
    entry: {
      id: string;
      supplierAccountId: string;
      amountCny: Amount4;
      balanceBeforeCny: Amount4;
      balanceAfterCny: Amount4;
      supplierNameSnapshot: string;
      createdAt: Date;
    },
    idempotentReplay: boolean
  ) {
    return {
      ledgerEntryId: entry.id,
      supplierAccountId: entry.supplierAccountId,
      supplierName: entry.supplierNameSnapshot,
      amountCny: entry.amountCny.toString(),
      balanceBeforeCny: entry.balanceBeforeCny.toString(),
      balanceAfterCny: entry.balanceAfterCny.toString(),
      isNegative: entry.balanceAfterCny.isNegative(),
      shortfallCny: entry.balanceAfterCny.isNegative()
        ? entry.balanceAfterCny.abs().toString()
        : '0',
      createdAt: entry.createdAt,
      idempotentReplay
    };
  }

  protected async writeAudit(
    tx: V2CommandTransaction,
    input: {
      operator?: AuthenticatedUser;
      action: string;
      objectType: string;
      objectId: string;
      beforeData?: V2JsonDocument;
      afterData?: V2JsonDocument;
      remark: string;
    }
  ) {
    await this.transactionalAudit.append(tx, {
      userId: input.operator?.id,
      module: 'id_business_v2',
      action: input.action,
      objectType: input.objectType,
      objectId: input.objectId,
      beforeData: input.beforeData ? toV2JsonDocument(input.beforeData) : undefined,
      afterData: input.afterData ? toV2JsonDocument(input.afterData) : undefined,
      remark: input.remark
    });
  }
}
