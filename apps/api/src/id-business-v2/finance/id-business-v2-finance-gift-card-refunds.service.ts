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
        if (replay) return this.assertReplay(replay, giftCardId, action, reason, dto.receivedAt);
        const card = await this.refundRepository.lock(tx, giftCardId);
        if (!card) throw new NotFoundException('礼品卡不存在');
        const lockedReplay = await this.commandRepository.findJournalReplay(
          tx,
          `${idempotencyKey}:journal`
        );
        if (lockedReplay)
          return this.assertReplay(lockedReplay, giftCardId, action, reason, dto.receivedAt);
        if (card.supplierRefundStatus !== 'pending') {
          throw new ConflictException('该礼品卡没有待处理的卡商退款');
        }
        if (await this.refundRepository.findPrematureWithdrawal(tx, giftCardId)) {
          throw new ConflictException('该礼品卡存在旧版提前返还余额，请先核对并受控纠正历史账务');
        }
        const withdrawal = await this.refundRepository.findWithdrawalJournal(tx, giftCardId);
        const evidence = withdrawal?.metadata;
        if (
          withdrawal?.status !== 'posted' ||
          !evidence ||
          typeof evidence !== 'object' ||
          Array.isArray(evidence) ||
          evidence.refundFundingVersion !== 2 ||
          evidence.refundOriginalAmount !== card.supplierRefundAmount.toString() ||
          evidence.refundCostAmountCny !== card.supplierRefundAmountCny.toString() ||
          evidence.supplierAccountId !== card.purchaseSupplierAccountId
        ) {
          throw new ConflictException('礼品卡缺少一致的原付款与撤回应收证据，请先核对历史账务');
        }
        const walletId = card.purchaseSupplierAccountId;
        if (action === 'received' && (evidence.fundingSource !== 'supplier_wallet' || !walletId)) {
          throw new ConflictException(
            '该退款资金来源尚不支持到账确认，请核对原资金账户或切账前证据'
          );
        }

        if (action === 'received' && walletId) {
          const wallet = await this.supplierWalletRepository.lock(tx, walletId);
          if (!wallet || wallet.currency !== 'CNY' || evidence.refundCurrency !== wallet.currency) {
            throw new ConflictException('当前仅支持原 CNY 卡商钱包退款到账，外币来源请先核对');
          }
          if (!card.supplierRefundAmount.equals(card.supplierRefundAmountCny)) {
            throw new ConflictException('人民币原付款数量与账面成本不一致，请先核对');
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
      { changedScopes: ['accounts', 'supplier-funds'], requestId: randomUUID(), operator }
    );
  }

  private assertReplay<
    T extends { sourceId: string | null; journalType: string; metadata: unknown; occurredAt: Date }
  >(
    replay: T,
    giftCardId: string,
    action: 'received' | 'written_off',
    reason: string,
    receivedAt?: string | null
  ) {
    const metadata = replay.metadata;
    if (
      replay.sourceId !== giftCardId ||
      replay.journalType !==
        (action === 'received' ? 'gift_card_refund_received' : 'gift_card_refund_write_off') ||
      !metadata ||
      typeof metadata !== 'object' ||
      Array.isArray(metadata) ||
      !('reason' in metadata) ||
      metadata.reason !== reason ||
      (receivedAt &&
        replay.occurredAt.getTime() !== normalizeFinanceDate(receivedAt, '处理时间').getTime())
    ) {
      throw new ConflictException('退款幂等键已用于不同的礼品卡或处理内容');
    }
    return replay;
  }
}
