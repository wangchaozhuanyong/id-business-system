import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { AuthenticatedUser } from '../../auth/auth.types';
import { V2CommandTransactionManager, V2TransactionalAuditService } from '../runtime/public-api';
import type { CloseIdBusinessV2GiftCardRefundDto } from './dto/id-business-v2-finance.dto';
import {
  normalizeFinanceDate,
  normalizeFinanceIdempotencyKey,
  normalizeFinanceText,
  normalizeFinanceUuid
} from './id-business-v2-finance-input';
import { IdBusinessV2FinancePostingService } from './id-business-v2-finance-posting.service';
import { IdBusinessV2FinanceCommandRepository } from './persistence/id-business-v2-finance-command.repository';
import { IdBusinessV2FinanceGiftCardRefundRepository } from './persistence/id-business-v2-finance-gift-card-refund.repository';
import { IdBusinessV2FinanceSupplierWalletRepository } from './persistence/id-business-v2-finance-supplier-wallet.repository';

@Injectable()
export class IdBusinessV2FinanceGiftCardRefundsService {
  constructor(
    private readonly commandTransactions: V2CommandTransactionManager,
    private readonly commandRepository: IdBusinessV2FinanceCommandRepository,
    private readonly refundRepository: IdBusinessV2FinanceGiftCardRefundRepository,
    private readonly supplierWalletRepository: IdBusinessV2FinanceSupplierWalletRepository,
    private readonly audit: V2TransactionalAuditService,
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
    return this.commandTransactions.execute(
      async (tx) => {
        const replay = await this.commandRepository.findJournalReplay(
          tx,
          `${idempotencyKey}:journal`
        );
        if (replay) return replay;
        const card = await this.refundRepository.lock(tx, giftCardId);
        if (!card) throw new NotFoundException('礼品卡不存在');
        if (card.supplierRefundStatus !== 'pending') {
          throw new ConflictException('该礼品卡没有待处理的卡商退款');
        }
        let walletId = card.purchaseSupplierAccountId;
        if (!walletId) {
          walletId = await this.refundRepository.findOriginalSupplierWalletId(tx, giftCardId);
        }
        if (action === 'received' && !walletId) {
          throw new ConflictException('礼品卡缺少原卡商钱包，不能确认退款到账');
        }

        if (action === 'received' && walletId) {
          const wallet = await this.supplierWalletRepository.lock(tx, walletId);
          if (!wallet || wallet.currency !== 'CNY') {
            throw new ConflictException('第一版礼品卡退款要求原卡商钱包币种为 CNY');
          }
          const nextBalance = wallet.currentBalance.add(card.supplierRefundAmount);
          const nextBalanceCny = wallet.currentBalanceCny.add(card.supplierRefundAmountCny);
          await this.refundRepository.createReceivedLedger(tx, {
            id: randomUUID(),
            supplierAccountId: wallet.id,
            giftCardId,
            entryType: 'gift_card_refund_received',
            direction: 'credit',
            currency: 'CNY',
            amount: card.supplierRefundAmount.toString(),
            balanceBefore: wallet.currentBalance.toString(),
            balanceAfter: nextBalance.toString(),
            amountCny: card.supplierRefundAmountCny.toString(),
            balanceBeforeCny: wallet.currentBalanceCny.toString(),
            balanceAfterCny: nextBalanceCny.toString(),
            supplierNameSnapshot: wallet.supplierName,
            idempotencyKey: `${idempotencyKey}:ledger`,
            reason,
            createdByUserId: operator?.id
          });
          await this.refundRepository.updateSupplierWalletBalances(
            tx,
            wallet.id,
            nextBalance.toString(),
            nextBalanceCny.toString(),
            operator?.id
          );
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
        await this.refundRepository.closeGiftCard(tx, giftCardId, action, occurredAt, operator?.id);
        await this.audit.append(tx, {
          userId: operator?.id,
          module: 'id_business_v2_finance',
          action: `id_business_v2.gift_card_refund.${action}`,
          objectType: 'id_business_v2_gift_card',
          objectId: giftCardId,
          afterData: {
            status: action,
            amountCny: card.supplierRefundAmountCny.toString(),
            journalId: journal.id,
            reason
          },
          remark: action === 'received' ? '确认卡商退款到账' : '确认卡商退款无法收回'
        });
        return journal;
      },
      { requestId: randomUUID(), operator }
    );
  }
}
