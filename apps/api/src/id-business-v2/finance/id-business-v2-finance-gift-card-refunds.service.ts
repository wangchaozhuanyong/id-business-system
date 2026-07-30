import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma as PrismaNamespace } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import type { AuthenticatedUser } from '../../auth/auth.types';
import { PrismaService } from '../../common/prisma/prisma.service';
import { toV2DecimalString } from '../decimal-policy';
import type { CloseIdBusinessV2GiftCardRefundDto } from './dto/id-business-v2-finance.dto';
import {
  normalizeFinanceDate,
  normalizeFinanceIdempotencyKey,
  normalizeFinanceText,
  normalizeFinanceUuid
} from './id-business-v2-finance-input';
import { IdBusinessV2FinancePostingService } from './id-business-v2-finance-posting.service';

@Injectable()
export class IdBusinessV2FinanceGiftCardRefundsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly postingService: IdBusinessV2FinancePostingService
  ) {}

  receive(
    giftCardIdValue: string,
    dto: CloseIdBusinessV2GiftCardRefundDto,
    operator?: AuthenticatedUser
  ) {
    return this.close(giftCardIdValue, dto, 'received', operator);
  }

  writeOff(
    giftCardIdValue: string,
    dto: CloseIdBusinessV2GiftCardRefundDto,
    operator?: AuthenticatedUser
  ) {
    return this.close(giftCardIdValue, dto, 'written_off', operator);
  }

  private async close(
    giftCardIdValue: string,
    dto: CloseIdBusinessV2GiftCardRefundDto,
    action: 'received' | 'written_off',
    operator?: AuthenticatedUser
  ) {
    const giftCardId = normalizeFinanceUuid(giftCardIdValue, '礼品卡');
    const reason = normalizeFinanceText(dto.reason, '处理原因', 500, true)!;
    const occurredAt = dto.receivedAt
      ? normalizeFinanceDate(dto.receivedAt, '处理时间')
      : new Date();
    const idempotencyKey = normalizeFinanceIdempotencyKey(
      dto.idempotencyKey,
      `gift_card_refund_${action}`
    );
    return this.prisma.$transaction(async (tx) => {
      const replay = await tx.idBusinessV2FinanceJournal.findUnique({
        where: { idempotencyKey: `${idempotencyKey}:journal` },
        include: { lines: true }
      });
      if (replay) return replay;
      const cards = await tx.$queryRaw<
        Array<{
          id: string;
          codeMasked: string;
          supplierRefundStatus: string;
          supplierRefundAmount: PrismaNamespace.Decimal;
          supplierRefundAmountCny: PrismaNamespace.Decimal;
          purchaseSupplierAccountId: string | null;
        }>
      >(PrismaNamespace.sql`
        SELECT
          "id",
          "code_masked" AS "codeMasked",
          "supplier_refund_status" AS "supplierRefundStatus",
          "supplier_refund_amount" AS "supplierRefundAmount",
          "supplier_refund_amount_cny" AS "supplierRefundAmountCny",
          "purchase_supplier_account_id" AS "purchaseSupplierAccountId"
        FROM "id_business_v2_gift_cards"
        WHERE "id" = CAST(${giftCardId} AS UUID)
        FOR UPDATE
      `);
      const card = cards[0];
      if (!card) throw new NotFoundException('礼品卡不存在');
      if (card.supplierRefundStatus !== 'pending') {
        throw new ConflictException('该礼品卡没有待处理的卡商退款');
      }
      let walletId = card.purchaseSupplierAccountId;
      if (!walletId) {
        const originalDebit = await tx.idBusinessV2TopupSupplierLedger.findFirst({
          where: { giftCardId, entryType: 'gift_card_debit' },
          orderBy: { createdAt: 'desc' },
          select: { supplierAccountId: true }
        });
        walletId = originalDebit?.supplierAccountId ?? null;
      }
      if (action === 'received' && !walletId) {
        throw new ConflictException('礼品卡缺少原卡商钱包，不能确认退款到账');
      }

      if (action === 'received' && walletId) {
        const wallets = await tx.$queryRaw<
          Array<{
            id: string;
            currency: 'CNY' | 'MYR' | 'USDT';
            currentBalance: PrismaNamespace.Decimal;
            currentBalanceCny: PrismaNamespace.Decimal;
            supplierName: string;
          }>
        >(PrismaNamespace.sql`
          SELECT
            wallet."id",
            wallet."currency",
            wallet."current_balance" AS "currentBalance",
            wallet."current_balance_cny" AS "currentBalanceCny",
            supplier."name" AS "supplierName"
          FROM "id_business_v2_topup_supplier_accounts" wallet
          INNER JOIN "id_business_v2_options" supplier
            ON supplier."id" = wallet."supplier_option_id"
          WHERE wallet."id" = CAST(${walletId} AS UUID)
          FOR UPDATE OF wallet
        `);
        const wallet = wallets[0];
        if (!wallet || wallet.currency !== 'CNY') {
          throw new ConflictException('第一版礼品卡退款要求原卡商钱包币种为 CNY');
        }
        const nextBalance = wallet.currentBalance.add(card.supplierRefundAmount);
        const nextBalanceCny = wallet.currentBalanceCny.add(card.supplierRefundAmountCny);
        await tx.idBusinessV2TopupSupplierLedger.create({
          data: {
            id: randomUUID(),
            supplierAccountId: wallet.id,
            giftCardId,
            entryType: 'gift_card_refund_received',
            direction: 'credit',
            currency: 'CNY',
            amount: card.supplierRefundAmount,
            balanceBefore: wallet.currentBalance,
            balanceAfter: nextBalance,
            amountCny: card.supplierRefundAmountCny,
            balanceBeforeCny: wallet.currentBalanceCny,
            balanceAfterCny: nextBalanceCny,
            supplierNameSnapshot: wallet.supplierName,
            idempotencyKey: `${idempotencyKey}:ledger`,
            reason,
            createdByUserId: operator?.id
          }
        });
        await tx.idBusinessV2TopupSupplierAccount.update({
          where: { id: wallet.id },
          data: {
            currentBalance: nextBalance,
            currentBalanceCny: nextBalanceCny,
            updatedByUserId: operator?.id
          }
        });
      }

      const journal = await this.postingService.post(tx, {
        journalType:
          action === 'received' ? 'gift_card_refund_received' : 'gift_card_refund_write_off',
        sourceType: 'gift_card',
        sourceId: giftCardId,
        sourceReference: card.codeMasked,
        occurredAt,
        summary:
          action === 'received'
            ? `卡商退款到账：${card.codeMasked}`
            : `卡商退款无法收回：${card.codeMasked}`,
        metadata: { reason },
        idempotencyKey: `${idempotencyKey}:journal`,
        operator,
        lines: [
          {
            accountCode:
              action === 'received' ? 'supplier_prepayment' : 'gift_card_redemption_loss',
            direction: 'debit',
            currency: 'CNY',
            amountOriginal: card.supplierRefundAmountCny,
            fxRateToCny: 1,
            amountCny: card.supplierRefundAmountCny,
            supplierAccountId: action === 'received' ? walletId : null,
            memo: reason
          },
          {
            accountCode: 'supplier_refund_receivable',
            direction: 'credit',
            currency: 'CNY',
            amountOriginal: card.supplierRefundAmountCny,
            fxRateToCny: 1,
            amountCny: card.supplierRefundAmountCny,
            memo: '关闭待卡商退款'
          }
        ]
      });
      await tx.idBusinessV2GiftCard.update({
        where: { id: giftCardId },
        data: {
          supplierRefundStatus: action,
          supplierRefundClosedAt: occurredAt,
          updatedByUserId: operator?.id
        }
      });
      await tx.auditLog.create({
        data: {
          userId: operator?.id,
          module: 'id_business_v2_finance',
          action: `id_business_v2.gift_card_refund.${action}`,
          objectType: 'id_business_v2_gift_card',
          objectId: giftCardId,
          afterData: {
            status: action,
            amountCny: toV2DecimalString(card.supplierRefundAmountCny),
            journalId: journal.id,
            reason
          },
          remark: action === 'received' ? '确认卡商退款到账' : '确认卡商退款无法收回'
        }
      });
      return journal;
    });
  }
}
