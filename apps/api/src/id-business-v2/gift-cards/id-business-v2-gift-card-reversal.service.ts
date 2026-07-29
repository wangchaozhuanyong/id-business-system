import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException
} from '@nestjs/common';
import { Prisma as PrismaNamespace } from '@prisma/client';
import type { Prisma } from '@prisma/client';
import type { AuthenticatedUser } from '../../auth/auth.types';
import { PrismaService } from '../../common/prisma/prisma.service';
import { IdBusinessV2BalanceCalculatorService } from '../balances/public-api';
import type {
  IdBusinessV2GiftCardReversalAction,
  ReverseIdBusinessV2GiftCardDto
} from './dto/reverse-id-business-v2-gift-card.dto';

interface LockedAccountRow {
  id: string;
  appleIdMasked: string;
  currentBalance: PrismaNamespace.Decimal;
  balanceCostAmount: PrismaNamespace.Decimal;
}

interface LockedGiftCardRow {
  id: string;
  accountId: string;
  supplierOptionId: string | null;
  sourceAttachmentId: string | null;
  codeMasked: string;
  codeTail: string;
  faceValue: PrismaNamespace.Decimal;
  exchangeRate: PrismaNamespace.Decimal;
  costAmount: PrismaNamespace.Decimal;
  status: string;
  createdAt: Date;
}

export interface IdBusinessV2GiftCardReversalResponse {
  action: IdBusinessV2GiftCardReversalAction;
  giftCard: {
    id: string;
    codeMasked: string;
    codeTail: string;
    faceValue: string;
    exchangeRate: string;
    originalCostAmount: string;
    status: string;
    statusChangedAt: Date;
  };
  ledgerEntry: {
    id: string;
    entryType: string;
    balanceAmount: string;
    costAmount: string;
    balanceBefore: string;
    balanceAfter: string;
    costBefore: string;
    costAfter: string;
    averageCostBefore: string;
    averageCostAfter: string;
    reversalOfEntryId: string;
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

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,100}$/;

@Injectable()
export class IdBusinessV2GiftCardReversalService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly balanceCalculator: IdBusinessV2BalanceCalculatorService
  ) {}

  async listReversible(accountIdValue: string) {
    const accountId = this.normalizeUuid(accountIdValue, '目标 ID');
    const account = await this.prisma.idBusinessV2Account.findFirst({
      where: {
        id: accountId,
        deletedAt: null,
        recordStatus: 'active'
      },
      select: {
        id: true,
        appleIdMasked: true
      }
    });
    if (!account) {
      throw new NotFoundException('目标 ID 不存在或已停用');
    }

    const giftCards = await this.prisma.idBusinessV2GiftCard.findMany({
      where: {
        accountId,
        status: 'credited',
        ledgerEntries: {
          some: {
            entryType: 'gift_card_credit'
          }
        }
      },
      select: {
        id: true,
        codeMasked: true,
        codeTail: true,
        faceValue: true,
        exchangeRate: true,
        costAmount: true,
        status: true,
        createdAt: true,
        supplierOption: {
          select: {
            id: true,
            name: true
          }
        },
        ledgerEntries: {
          where: {
            entryType: 'gift_card_credit'
          },
          select: {
            id: true,
            balanceBefore: true,
            balanceAfter: true,
            createdAt: true
          },
          take: 1
        }
      },
      orderBy: {
        createdAt: 'desc'
      },
      take: 101
    });
    const items = giftCards.slice(0, 100);

    return {
      account,
      items: items.map((giftCard) => ({
        id: giftCard.id,
        codeMasked: giftCard.codeMasked,
        codeTail: giftCard.codeTail,
        faceValue: giftCard.faceValue.toString(),
        exchangeRate: giftCard.exchangeRate.toString(),
        costAmount: giftCard.costAmount.toString(),
        status: giftCard.status,
        supplier: giftCard.supplierOption,
        creditedLedger: giftCard.ledgerEntries[0]
          ? {
              id: giftCard.ledgerEntries[0].id,
              balanceBefore: giftCard.ledgerEntries[0].balanceBefore.toString(),
              balanceAfter: giftCard.ledgerEntries[0].balanceAfter.toString(),
              createdAt: giftCard.ledgerEntries[0].createdAt
            }
          : null,
        createdAt: giftCard.createdAt
      })),
      total: items.length,
      limited: giftCards.length > 100
    };
  }

  async reverse(
    giftCardIdValue: string,
    dto: ReverseIdBusinessV2GiftCardDto,
    operator?: AuthenticatedUser
  ) {
    const giftCardId = this.normalizeUuid(giftCardIdValue, '礼品卡');
    const action = this.normalizeAction(dto.action);
    const reason = this.normalizeReason(dto.reason);
    const idempotencyKey = this.buildIdempotencyKey(
      giftCardId,
      this.normalizeIdempotencyKey(dto.idempotencyKey)
    );
    const entryType = this.getEntryType(action);

    try {
      return await this.prisma.$transaction(async (tx) => {
        const locator = await tx.idBusinessV2GiftCard.findUnique({
          where: { id: giftCardId },
          select: { accountId: true }
        });
        if (!locator) {
          throw new NotFoundException('礼品卡记录不存在');
        }

        const account = await this.lockAccount(tx, locator.accountId);
        const existingEntry = await tx.idBusinessV2BalanceLedger.findUnique({
          where: { idempotencyKey },
          include: {
            giftCard: true
          }
        });
        if (existingEntry?.giftCard) {
          this.assertReplayMatches(existingEntry, giftCardId, entryType, reason);
          return this.toResponse(action, account, existingEntry.giftCard, existingEntry, true);
        }

        const giftCard = await this.lockGiftCard(tx, giftCardId);
        if (giftCard.accountId !== account.id) {
          throw new ConflictException('礼品卡所属 ID 已变化，请刷新后重试');
        }
        if (giftCard.status !== 'credited') {
          throw new ConflictException(
            giftCard.status === 'redeemed' ? '礼品卡已标记被赎回' : '礼品卡已撤回'
          );
        }

        const originalEntry = await tx.idBusinessV2BalanceLedger.findUnique({
          where: {
            giftCardId_entryType: {
              giftCardId,
              entryType: 'gift_card_credit'
            }
          },
          select: {
            id: true
          }
        });
        if (!originalEntry) {
          throw new ConflictException('礼品卡缺少原入账流水，不能执行反向处理');
        }

        const existingReversal = await tx.idBusinessV2BalanceLedger.findUnique({
          where: {
            reversalOfEntryId: originalEntry.id
          },
          select: {
            id: true,
            entryType: true
          }
        });
        if (existingReversal) {
          throw new ConflictException('原入账流水已经执行过反向处理');
        }

        const snapshot = this.balanceCalculator.calculateConsumption(
          {
            currentBalance: account.currentBalance,
            balanceCostAmount: account.balanceCostAmount
          },
          giftCard.faceValue
        );

        const ledgerEntry = await tx.idBusinessV2BalanceLedger.create({
          data: {
            accountId: account.id,
            giftCardId,
            entryType,
            direction: 'debit',
            balanceAmount: snapshot.balanceAmount,
            costAmount: snapshot.costAmount,
            balanceBefore: snapshot.balanceBefore,
            balanceAfter: snapshot.balanceAfter,
            costBefore: snapshot.costBefore,
            costAfter: snapshot.costAfter,
            averageCostBefore: snapshot.averageCostBefore,
            averageCostAfter: snapshot.averageCostAfter,
            reversalOfEntryId: originalEntry.id,
            idempotencyKey,
            remark: reason,
            createdByUserId: operator?.id
          }
        });

        const statusChangedAt = new Date();
        const updatedGiftCard = await tx.idBusinessV2GiftCard.update({
          where: { id: giftCardId },
          data: {
            status: action,
            statusChangedAt,
            updatedByUserId: operator?.id
          },
          select: {
            id: true,
            codeMasked: true,
            codeTail: true,
            faceValue: true,
            exchangeRate: true,
            costAmount: true,
            status: true,
            statusChangedAt: true,
            createdAt: true
          }
        });

        const updatedAccount = await tx.idBusinessV2Account.update({
          where: { id: account.id },
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

        const result = this.toResponse(action, updatedAccount, updatedGiftCard, ledgerEntry, false);
        await this.writeAuditLog(tx, result, reason, operator);
        return result;
      });
    } catch (error) {
      if (
        error instanceof PrismaNamespace.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException('礼品卡已经处理或请求已经完成，请刷新后核对');
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
        "balance_cost_amount" AS "balanceCostAmount"
      FROM "id_business_v2_accounts"
      WHERE
        "id" = CAST(${accountId} AS UUID)
        AND "deleted_at" IS NULL
        AND "record_status" = 'active'
      FOR UPDATE
    `);
    const account = accounts[0];
    if (!account) {
      throw new NotFoundException('目标 ID 不存在或已停用');
    }
    return account;
  }

  private async lockGiftCard(tx: Prisma.TransactionClient, giftCardId: string) {
    const giftCards = await tx.$queryRaw<LockedGiftCardRow[]>(PrismaNamespace.sql`
      SELECT
        "id",
        "account_id" AS "accountId",
        "supplier_option_id" AS "supplierOptionId",
        "source_attachment_id" AS "sourceAttachmentId",
        "code_masked" AS "codeMasked",
        "code_tail" AS "codeTail",
        "face_value" AS "faceValue",
        "exchange_rate" AS "exchangeRate",
        "cost_amount" AS "costAmount",
        "status",
        "created_at" AS "createdAt"
      FROM "id_business_v2_gift_cards"
      WHERE "id" = CAST(${giftCardId} AS UUID)
      FOR UPDATE
    `);
    const giftCard = giftCards[0];
    if (!giftCard) {
      throw new NotFoundException('礼品卡记录不存在');
    }
    return giftCard;
  }

  private assertReplayMatches(
    entry: {
      giftCardId: string | null;
      entryType: string;
      remark: string | null;
    },
    giftCardId: string,
    entryType: 'gift_card_redeemed' | 'gift_card_withdrawal',
    reason: string
  ) {
    if (
      entry.giftCardId !== giftCardId ||
      entry.entryType !== entryType ||
      entry.remark !== reason
    ) {
      throw new ConflictException('幂等键已用于其他反向处理，请刷新后重新提交');
    }
  }

  private toResponse(
    action: IdBusinessV2GiftCardReversalAction,
    account: {
      id: string;
      appleIdMasked: string;
      currentBalance: PrismaNamespace.Decimal;
      balanceCostAmount: PrismaNamespace.Decimal;
    },
    giftCard: {
      id: string;
      codeMasked: string;
      codeTail: string;
      faceValue: PrismaNamespace.Decimal;
      exchangeRate: PrismaNamespace.Decimal;
      costAmount: PrismaNamespace.Decimal;
      status: string;
      statusChangedAt: Date;
    },
    ledgerEntry: {
      id: string;
      entryType: string;
      balanceAmount: PrismaNamespace.Decimal;
      costAmount: PrismaNamespace.Decimal;
      balanceBefore: PrismaNamespace.Decimal;
      balanceAfter: PrismaNamespace.Decimal;
      costBefore: PrismaNamespace.Decimal;
      costAfter: PrismaNamespace.Decimal;
      averageCostBefore: PrismaNamespace.Decimal;
      averageCostAfter: PrismaNamespace.Decimal;
      reversalOfEntryId: string | null;
      createdAt: Date;
    },
    idempotentReplay: boolean
  ): IdBusinessV2GiftCardReversalResponse {
    if (!ledgerEntry.reversalOfEntryId) {
      throw new ConflictException('反向流水缺少原入账流水引用');
    }
    return {
      action,
      giftCard: {
        id: giftCard.id,
        codeMasked: giftCard.codeMasked,
        codeTail: giftCard.codeTail,
        faceValue: giftCard.faceValue.toString(),
        exchangeRate: giftCard.exchangeRate.toString(),
        originalCostAmount: giftCard.costAmount.toString(),
        status: giftCard.status,
        statusChangedAt: giftCard.statusChangedAt
      },
      ledgerEntry: {
        id: ledgerEntry.id,
        entryType: ledgerEntry.entryType,
        balanceAmount: ledgerEntry.balanceAmount.toString(),
        costAmount: ledgerEntry.costAmount.toString(),
        balanceBefore: ledgerEntry.balanceBefore.toString(),
        balanceAfter: ledgerEntry.balanceAfter.toString(),
        costBefore: ledgerEntry.costBefore.toString(),
        costAfter: ledgerEntry.costAfter.toString(),
        averageCostBefore: ledgerEntry.averageCostBefore.toString(),
        averageCostAfter: ledgerEntry.averageCostAfter.toString(),
        reversalOfEntryId: ledgerEntry.reversalOfEntryId,
        createdAt: ledgerEntry.createdAt
      },
      account: {
        id: account.id,
        appleIdMasked: account.appleIdMasked,
        currentBalance: account.currentBalance.toString(),
        balanceCostAmount: account.balanceCostAmount.toString()
      },
      idempotentReplay
    };
  }

  private async writeAuditLog(
    tx: Prisma.TransactionClient,
    result: IdBusinessV2GiftCardReversalResponse,
    reason: string,
    operator?: AuthenticatedUser
  ) {
    const actionLabel = result.action === 'redeemed' ? '标记被赎回' : '撤回';
    await tx.auditLog.create({
      data: {
        userId: operator?.id,
        module: 'id_business_v2',
        action: `id_business_v2.gift_card.${result.action}`,
        objectType: 'id_business_v2_gift_card',
        objectId: result.giftCard.id,
        beforeData: {
          status: 'credited',
          balance: result.ledgerEntry.balanceBefore,
          balanceCostAmount: result.ledgerEntry.costBefore
        },
        afterData: {
          status: result.giftCard.status,
          codeMasked: result.giftCard.codeMasked,
          balanceAmount: result.ledgerEntry.balanceAmount,
          costAmount: result.ledgerEntry.costAmount,
          balance: result.ledgerEntry.balanceAfter,
          balanceCostAmount: result.ledgerEntry.costAfter,
          reversalOfEntryId: result.ledgerEntry.reversalOfEntryId,
          reason
        },
        remark: `V2 礼品卡${actionLabel}：${result.giftCard.codeMasked}`
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

  private normalizeAction(value: unknown): IdBusinessV2GiftCardReversalAction {
    if (value === 'redeemed' || value === 'withdrawn') return value;
    throw new BadRequestException('反向处理类型无效');
  }

  private normalizeReason(value: unknown) {
    const normalized = typeof value === 'string' ? value.trim() : '';
    if (normalized.length < 2 || normalized.length > 500) {
      throw new BadRequestException('处理原因必须为 2 至 500 个字符');
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

  private buildIdempotencyKey(giftCardId: string, value: string) {
    return `gift_card_reversal:${giftCardId}:${value}`;
  }

  private getEntryType(action: IdBusinessV2GiftCardReversalAction) {
    return action === 'redeemed'
      ? ('gift_card_redeemed' as const)
      : ('gift_card_withdrawal' as const);
  }
}
