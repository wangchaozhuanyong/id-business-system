import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException
} from '@nestjs/common';
import { Prisma as PrismaNamespace } from '@prisma/client';
import type { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import type { AuthenticatedUser } from '../../auth/auth.types';
import { FieldEncryptionService } from '../../common/crypto/field-encryption.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { IdBusinessV2BalanceCalculatorService } from '../balances/public-api';
import { IdBusinessV2ExchangeRateQueryService } from '../exchange-rates/public-api';
import { toV2DecimalString } from '../decimal-policy';
import type { ConfirmIdBusinessV2GiftCardCreditDto } from './dto/confirm-id-business-v2-gift-card-credit.dto';

interface LockedAccountRow {
  id: string;
  appleIdMasked: string;
  currentBalance: PrismaNamespace.Decimal;
  balanceCostAmount: PrismaNamespace.Decimal;
  soldByOrderId: string | null;
  lossReportedAt: Date | null;
}

export interface CreditResponse {
  giftCard: {
    id: string;
    codeMasked: string;
    codeTail: string;
    faceValue: string;
    exchangeRate: string;
    exchangeRateSource: string;
    exchangeRateSnapshotId: string | null;
    exchangeRatePrefilledValue: string | null;
    exchangeRateWasOverridden: boolean;
    costAmount: string;
    status: string;
    supplierOptionId: string | null;
    sourceAttachmentId: string | null;
    createdAt: Date;
  };
  ledgerEntry: {
    id: string;
    balanceBefore: string;
    balanceAfter: string;
    costBefore: string;
    costAfter: string;
    averageCostBefore: string;
    averageCostAfter: string;
    createdAt: Date;
  };
  account: {
    id: string;
    appleIdMasked: string;
    currentBalance: string;
    balanceCostAmount: string;
  };
  idempotentReplay: boolean;
}

export interface CreditAuditContext {
  source: 'renewal_workbench';
  activationId: string;
  orderId: string;
  orderNo: string;
}

export interface CreditTransactionHookContext {
  tx: Prisma.TransactionClient;
  accountId: string;
  giftCardId: string;
  ledgerEntryId: string;
  idempotentReplay: boolean;
}

export type CreditTransactionHook = (context: CreditTransactionHookContext) => Promise<void>;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CODE_PATTERN = /^[A-Z0-9]{10,64}$/;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,100}$/;

@Injectable()
export class IdBusinessV2GiftCardCreditService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly fieldEncryptionService: FieldEncryptionService,
    private readonly balanceCalculator: IdBusinessV2BalanceCalculatorService,
    private readonly exchangeRateQueryService: IdBusinessV2ExchangeRateQueryService
  ) {}

  async confirmCredit(
    accountIdValue: string,
    dto: ConfirmIdBusinessV2GiftCardCreditDto,
    operator?: AuthenticatedUser,
    auditContext?: CreditAuditContext,
    transactionHook?: CreditTransactionHook
  ) {
    const accountId = this.normalizeUuid(accountIdValue, '目标 ID');
    const code = this.normalizeCode(dto.code);
    const codeHash = this.fieldEncryptionService.hash(code);
    const codeEncrypted = this.fieldEncryptionService.encrypt(code);
    if (!codeHash || !codeEncrypted) {
      throw new BadRequestException('礼品卡号不能为空');
    }

    const supplierOptionId = this.normalizeUuid(dto.supplierOptionId, '加卡供应商');
    const idempotencyKey = this.buildIdempotencyKey(
      accountId,
      this.normalizeIdempotencyKey(dto.idempotencyKey)
    );
    const remark = this.normalizeRemark(dto.remark);
    const exchangeRateAudit = await this.resolveExchangeRateAudit(dto);

    try {
      const result = await this.prisma.$transaction(async (tx) => {
        const account = await this.lockAccount(tx, accountId);
        const existingEntry = await tx.idBusinessV2BalanceLedger.findUnique({
          where: { idempotencyKey },
          include: {
            giftCard: true
          }
        });

        if (existingEntry?.giftCard) {
          if (account.lossReportedAt) {
            throw new ConflictException('已报损 ID 永久冻结，不能继续加卡');
          }
          this.assertReplayMatches(existingEntry.giftCard, {
            accountId,
            codeHash,
            faceValue: dto.faceValue,
            exchangeRate: dto.exchangeRate,
            exchangeRateAudit,
            supplierOptionId,
            remark
          });
          await transactionHook?.({
            tx,
            accountId,
            giftCardId: existingEntry.giftCard.id,
            ledgerEntryId: existingEntry.id,
            idempotentReplay: true
          });
          return this.toResponse(account, existingEntry.giftCard, existingEntry, true);
        }
        if (account.lossReportedAt) {
          throw new ConflictException('已报损 ID 永久冻结，不能继续加卡');
        }
        if (account.soldByOrderId) {
          throw new ConflictException('该 ID 已卖出，不能继续加卡');
        }

        const supplier = await tx.idBusinessV2Option.findFirst({
          where: {
            id: supplierOptionId,
            type: 'topup_supplier',
            status: 'active',
            deletedAt: null
          },
          select: {
            id: true,
            name: true
          }
        });
        if (!supplier) {
          throw new BadRequestException('加卡供应商不存在或已停用');
        }

        const duplicateGiftCard = await tx.idBusinessV2GiftCard.findUnique({
          where: { codeHash },
          select: { id: true }
        });
        if (duplicateGiftCard) {
          throw new ConflictException('礼品卡号已入账，请勿重复使用');
        }

        const snapshot = this.balanceCalculator.calculateGiftCardCredit(
          {
            currentBalance: account.currentBalance,
            balanceCostAmount: account.balanceCostAmount
          },
          dto.faceValue,
          dto.exchangeRate
        );
        const giftCardId = randomUUID();

        const giftCard = await tx.idBusinessV2GiftCard.create({
          data: {
            id: giftCardId,
            accountId,
            supplierOptionId: supplier.id,
            sourceAttachmentId: null,
            codeEncrypted,
            codeHash,
            codeMasked: this.maskCode(code),
            codeTail: this.getCodeTail(code),
            faceValue: snapshot.balanceAmount,
            exchangeRate: snapshot.exchangeRate,
            exchangeRateSource: exchangeRateAudit.exchangeRateSource,
            exchangeRateSnapshotId: exchangeRateAudit.exchangeRateSnapshotId,
            exchangeRatePrefilledValue: exchangeRateAudit.exchangeRatePrefilledValue,
            exchangeRateWasOverridden: exchangeRateAudit.exchangeRateWasOverridden,
            costAmount: snapshot.costAmount,
            status: 'credited',
            remark,
            createdByUserId: operator?.id,
            updatedByUserId: operator?.id
          }
        });

        const ledgerEntry = await tx.idBusinessV2BalanceLedger.create({
          data: {
            accountId,
            giftCardId: giftCard.id,
            entryType: 'gift_card_credit',
            direction: 'credit',
            balanceAmount: snapshot.balanceAmount,
            costAmount: snapshot.costAmount,
            balanceBefore: snapshot.balanceBefore,
            balanceAfter: snapshot.balanceAfter,
            costBefore: snapshot.costBefore,
            costAfter: snapshot.costAfter,
            averageCostBefore: snapshot.averageCostBefore,
            averageCostAfter: snapshot.averageCostAfter,
            reversalOfEntryId: null,
            idempotencyKey,
            remark,
            createdByUserId: operator?.id
          }
        });

        const updatedAccount = await tx.idBusinessV2Account.update({
          where: { id: accountId },
          data: {
            currentBalance: snapshot.balanceAfter,
            balanceCostAmount: snapshot.costAfter,
            updatedByUserId: operator?.id
          },
          select: {
            id: true,
            appleIdMasked: true,
            currentBalance: true,
            balanceCostAmount: true
          }
        });

        const result = this.toResponse(updatedAccount, giftCard, ledgerEntry, false);
        await this.writeAuditLogs(tx, result, operator, auditContext);
        await transactionHook?.({
          tx,
          accountId,
          giftCardId: giftCard.id,
          ledgerEntryId: ledgerEntry.id,
          idempotentReplay: false
        });
        return result;
      });

      return result;
    } catch (error) {
      if (
        error instanceof PrismaNamespace.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException('礼品卡号已入账或请求已处理，请刷新后核对');
      }
      throw error;
    }
  }

  private async lockAccount(tx: Prisma.TransactionClient, accountId: string) {
    const accounts = await tx.$queryRaw<LockedAccountRow[]>(PrismaNamespace.sql`
      SELECT
        "id",
        "apple_id_masked" AS "appleIdMasked",
        "current_balance" AS "currentBalance",
        "balance_cost_amount" AS "balanceCostAmount",
        "sold_by_order_id" AS "soldByOrderId",
        "loss_reported_at" AS "lossReportedAt"
      FROM "id_business_v2_accounts"
      WHERE
        "id" = CAST(${accountId} AS UUID)
        AND "deleted_at" IS NULL
        AND "record_status" = 'active'
        AND "loss_reported_at" IS NULL
      FOR UPDATE
    `);
    const account = accounts[0];
    if (!account) {
      throw new NotFoundException('目标 ID 不存在或已停用');
    }
    return account;
  }

  private assertReplayMatches(
    giftCard: {
      accountId: string;
      codeHash: string;
      faceValue: PrismaNamespace.Decimal;
      exchangeRate: PrismaNamespace.Decimal;
      exchangeRateSource: string;
      exchangeRateSnapshotId: string | null;
      exchangeRatePrefilledValue: PrismaNamespace.Decimal | null;
      exchangeRateWasOverridden: boolean;
      supplierOptionId: string | null;
      remark: string | null;
    },
    input: {
      accountId: string;
      codeHash: string;
      faceValue: PrismaNamespace.Decimal.Value;
      exchangeRate: PrismaNamespace.Decimal.Value;
      exchangeRateAudit: {
        exchangeRateSource: string;
        exchangeRateSnapshotId: string | null;
        exchangeRatePrefilledValue: PrismaNamespace.Decimal | null;
        exchangeRateWasOverridden: boolean;
      };
      supplierOptionId: string;
      remark: string | null;
    }
  ) {
    const snapshot = this.balanceCalculator.calculateGiftCardCredit(
      { currentBalance: '0', balanceCostAmount: '0' },
      input.faceValue,
      input.exchangeRate
    );
    if (
      giftCard.accountId !== input.accountId ||
      giftCard.codeHash !== input.codeHash ||
      !giftCard.faceValue.equals(snapshot.balanceAmount) ||
      !giftCard.exchangeRate.equals(snapshot.exchangeRate) ||
      giftCard.exchangeRateSource !== input.exchangeRateAudit.exchangeRateSource ||
      giftCard.exchangeRateSnapshotId !== input.exchangeRateAudit.exchangeRateSnapshotId ||
      !this.nullableDecimalEquals(
        giftCard.exchangeRatePrefilledValue,
        input.exchangeRateAudit.exchangeRatePrefilledValue
      ) ||
      giftCard.exchangeRateWasOverridden !== input.exchangeRateAudit.exchangeRateWasOverridden ||
      giftCard.supplierOptionId !== input.supplierOptionId ||
      giftCard.remark !== input.remark
    ) {
      throw new ConflictException('幂等键已用于其他入账内容，请刷新后重新提交');
    }
  }

  private toResponse(
    account: {
      id: string;
      appleIdMasked: string;
      currentBalance: PrismaNamespace.Decimal;
      balanceCostAmount: PrismaNamespace.Decimal;
    },
    giftCard: {
      id: string;
      supplierOptionId: string | null;
      sourceAttachmentId: string | null;
      codeMasked: string;
      codeTail: string;
      faceValue: PrismaNamespace.Decimal;
      exchangeRate: PrismaNamespace.Decimal;
      exchangeRateSource: string;
      exchangeRateSnapshotId: string | null;
      exchangeRatePrefilledValue: PrismaNamespace.Decimal | null;
      exchangeRateWasOverridden: boolean;
      costAmount: PrismaNamespace.Decimal;
      status: string;
      createdAt: Date;
    },
    ledgerEntry: {
      id: string;
      balanceBefore: PrismaNamespace.Decimal;
      balanceAfter: PrismaNamespace.Decimal;
      costBefore: PrismaNamespace.Decimal;
      costAfter: PrismaNamespace.Decimal;
      averageCostBefore: PrismaNamespace.Decimal;
      averageCostAfter: PrismaNamespace.Decimal;
      createdAt: Date;
    },
    idempotentReplay: boolean
  ): CreditResponse {
    return {
      giftCard: {
        id: giftCard.id,
        codeMasked: giftCard.codeMasked,
        codeTail: giftCard.codeTail,
        faceValue: toV2DecimalString(giftCard.faceValue),
        exchangeRate: toV2DecimalString(giftCard.exchangeRate),
        exchangeRateSource: giftCard.exchangeRateSource,
        exchangeRateSnapshotId: giftCard.exchangeRateSnapshotId,
        exchangeRatePrefilledValue:
          giftCard.exchangeRatePrefilledValue == null
            ? null
            : toV2DecimalString(giftCard.exchangeRatePrefilledValue),
        exchangeRateWasOverridden: giftCard.exchangeRateWasOverridden,
        costAmount: toV2DecimalString(giftCard.costAmount),
        status: giftCard.status,
        supplierOptionId: giftCard.supplierOptionId,
        sourceAttachmentId: giftCard.sourceAttachmentId,
        createdAt: giftCard.createdAt
      },
      ledgerEntry: {
        id: ledgerEntry.id,
        balanceBefore: toV2DecimalString(ledgerEntry.balanceBefore),
        balanceAfter: toV2DecimalString(ledgerEntry.balanceAfter),
        costBefore: toV2DecimalString(ledgerEntry.costBefore),
        costAfter: toV2DecimalString(ledgerEntry.costAfter),
        averageCostBefore: toV2DecimalString(ledgerEntry.averageCostBefore),
        averageCostAfter: toV2DecimalString(ledgerEntry.averageCostAfter),
        createdAt: ledgerEntry.createdAt
      },
      account: {
        id: account.id,
        appleIdMasked: account.appleIdMasked,
        currentBalance: toV2DecimalString(account.currentBalance),
        balanceCostAmount: toV2DecimalString(account.balanceCostAmount)
      },
      idempotentReplay
    };
  }

  private async writeAuditLogs(
    tx: Prisma.TransactionClient,
    result: CreditResponse,
    operator?: AuthenticatedUser,
    auditContext?: CreditAuditContext
  ) {
    await tx.auditLog.create({
      data: {
        userId: operator?.id,
        module: 'id_business_v2',
        action: 'id_business_v2.gift_card.credit',
        objectType: 'id_business_v2_gift_card',
        objectId: result.giftCard.id,
        afterData: {
          accountId: result.account.id,
          codeMasked: result.giftCard.codeMasked,
          codeTail: result.giftCard.codeTail,
          faceValue: result.giftCard.faceValue,
          exchangeRate: result.giftCard.exchangeRate,
          exchangeRateSource: result.giftCard.exchangeRateSource,
          exchangeRateSnapshotId: result.giftCard.exchangeRateSnapshotId,
          exchangeRatePrefilledValue: result.giftCard.exchangeRatePrefilledValue,
          exchangeRateWasOverridden: result.giftCard.exchangeRateWasOverridden,
          costAmount: result.giftCard.costAmount,
          supplierOptionId: result.giftCard.supplierOptionId,
          sourceAttachmentId: result.giftCard.sourceAttachmentId,
          balanceBefore: result.ledgerEntry.balanceBefore,
          balanceAfter: result.ledgerEntry.balanceAfter,
          costBefore: result.ledgerEntry.costBefore,
          costAfter: result.ledgerEntry.costAfter,
          ...(auditContext
            ? {
                sourceContext: {
                  source: auditContext.source,
                  activationId: auditContext.activationId,
                  orderId: auditContext.orderId,
                  orderNo: auditContext.orderNo
                }
              }
            : {})
        },
        remark: auditContext
          ? `V2 续费工作台礼品卡确认入账：${result.giftCard.codeMasked}`
          : `V2 礼品卡确认入账：${result.giftCard.codeMasked}`
      }
    });
  }

  private normalizeUuid(value: unknown, label: string) {
    const normalized = typeof value === 'string' ? value.trim() : '';
    if (!UUID_PATTERN.test(normalized)) {
      throw new BadRequestException(`${label}格式无效`);
    }
    return normalized;
  }

  private async resolveExchangeRateAudit(dto: ConfirmIdBusinessV2GiftCardCreditDto) {
    const snapshotId =
      typeof dto.exchangeRateSnapshotId === 'string' ? dto.exchangeRateSnapshotId.trim() : '';
    const hasPrefilledValue =
      dto.exchangeRatePrefilledValue !== undefined &&
      dto.exchangeRatePrefilledValue !== null &&
      String(dto.exchangeRatePrefilledValue).trim() !== '';
    if (snapshotId || hasPrefilledValue) {
      if (!snapshotId || !hasPrefilledValue) {
        throw new BadRequestException('自动汇率来源快照和预填值必须同时提交');
      }
      return this.exchangeRateQueryService.validatePrefill(
        snapshotId,
        dto.exchangeRatePrefilledValue,
        dto.exchangeRate
      );
    }
    return {
      exchangeRateSource: 'manual_input',
      exchangeRateSnapshotId: null,
      exchangeRatePrefilledValue: null,
      exchangeRateWasOverridden: false
    };
  }

  private nullableDecimalEquals(
    left: PrismaNamespace.Decimal | null,
    right: PrismaNamespace.Decimal | null
  ) {
    if (left === null || right === null) return left === right;
    return left.equals(right);
  }

  private normalizeCode(value: unknown) {
    const normalized =
      typeof value === 'string' ? value.toUpperCase().replace(/[^A-Z0-9]/g, '') : '';
    if (!CODE_PATTERN.test(normalized) || !/[A-Z]/.test(normalized) || !/\d/.test(normalized)) {
      throw new BadRequestException('礼品卡号必须是 10 至 64 位且同时包含字母和数字');
    }
    return normalized;
  }

  private normalizeIdempotencyKey(value: unknown) {
    const normalized = typeof value === 'string' ? value.trim() : '';
    if (!IDEMPOTENCY_KEY_PATTERN.test(normalized)) {
      throw new BadRequestException('幂等键必须是 8 至 100 位字母、数字或 ._:-');
    }
    return normalized;
  }

  private buildIdempotencyKey(accountId: string, value: string) {
    return `gift_card_credit:${accountId}:${value}`;
  }

  private normalizeRemark(value: unknown) {
    if (value === undefined || value === null) return null;
    if (typeof value !== 'string') {
      throw new BadRequestException('备注格式无效');
    }
    const normalized = value.trim();
    if (normalized.length > 2000) {
      throw new BadRequestException('备注不能超过 2000 个字符');
    }
    return normalized || null;
  }

  private maskCode(code: string) {
    return `${code.slice(0, 4)}****${this.getCodeTail(code)}`;
  }

  private getCodeTail(code: string) {
    return code.slice(-4);
  }
}
