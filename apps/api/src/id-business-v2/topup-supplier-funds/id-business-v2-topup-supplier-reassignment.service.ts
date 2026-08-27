import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { AuthenticatedUser } from '../../auth/auth.types';
import { V2CommandTransactionManager, V2TransactionalAuditService } from '../runtime/public-api';
import type { ReassignIdBusinessV2GiftCardSupplierDto } from './dto/topup-supplier-fund.dto';
import { IdBusinessV2TopupSupplierFundsSupport } from './id-business-v2-topup-supplier-funds-support';
import { IdBusinessV2TopupSupplierCommandRepository } from './persistence/id-business-v2-topup-supplier-command.repository';

@Injectable()
export class IdBusinessV2TopupSupplierReassignmentService extends IdBusinessV2TopupSupplierFundsSupport {
  constructor(
    repository: IdBusinessV2TopupSupplierCommandRepository,
    private readonly commandTransactions: V2CommandTransactionManager,
    transactionalAudit: V2TransactionalAuditService
  ) {
    super(repository, transactionalAudit);
  }

  async reassignGiftCardSupplier(
    giftCardIdValue: string,
    dto: ReassignIdBusinessV2GiftCardSupplierDto,
    operator?: AuthenticatedUser
  ) {
    this.assertFundManagementPermission(operator);
    const giftCardId = this.normalizeUuid(giftCardIdValue, '礼品卡');
    const newSupplierOptionId = this.normalizeUuid(dto.supplierOptionId, '新加卡供应商');
    const reason = this.normalizeReason(dto.reason);
    const requestKey = this.normalizeIdempotencyKey(dto.idempotencyKey);
    const outgoingKey = `supplier_reassign_out:${giftCardId}:${requestKey}`;
    const incomingKey = `supplier_reassign_in:${giftCardId}:${requestKey}`;

    return this.commandTransactions.execute(
      async (tx) => {
        const giftCard = await this.repository.findGiftCard(tx, giftCardId);
        if (!giftCard) throw new NotFoundException('礼品卡记录不存在');
        const { outgoing: existingOutgoing, incoming: existingIncoming } =
          await this.repository.findReassignmentReplays(tx, outgoingKey, incomingKey);
        if (existingOutgoing || existingIncoming) {
          if (
            !existingOutgoing ||
            !existingIncoming ||
            existingOutgoing.giftCardId !== giftCardId ||
            existingIncoming.giftCardId !== giftCardId ||
            existingIncoming.supplierAccount.supplierOptionId !== newSupplierOptionId ||
            existingOutgoing.reason !== `供应商更正返还：${reason}` ||
            existingIncoming.reason !== `供应商更正扣款：${reason}` ||
            giftCard.supplierOptionId !== newSupplierOptionId
          ) {
            throw new ConflictException('幂等键已用于不同的供应商更正操作');
          }
          return {
            giftCardId,
            supplier: await this.requireSupplierOption(tx, newSupplierOptionId),
            legacyCutoverRecord: false,
            oldSupplierBalance: {
              supplierOptionId: existingOutgoing.supplierAccount.supplierOptionId,
              beforeCny: existingOutgoing.balanceBeforeCny.toString(),
              afterCny: existingOutgoing.balanceAfterCny.toString()
            },
            newSupplierBalance: {
              supplierOptionId: existingIncoming.supplierAccount.supplierOptionId,
              beforeCny: existingIncoming.balanceBeforeCny.toString(),
              afterCny: existingIncoming.balanceAfterCny.toString(),
              isNegative: existingIncoming.balanceAfterCny.isNegative()
            },
            idempotentReplay: true
          };
        }
        if (giftCard.supplierOptionId === newSupplierOptionId) {
          const activeDebit = await this.repository.hasActiveGiftCardDebit(tx, giftCardId);
          if (!activeDebit) {
            return {
              giftCardId,
              supplier: await this.requireSupplierOption(tx, newSupplierOptionId),
              legacyCutoverRecord: true,
              oldSupplierBalance: null,
              newSupplierBalance: null,
              idempotentReplay: true
            };
          }
          throw new BadRequestException('新供应商与当前供应商相同');
        }
        const newSupplier = await this.requireSupplierOption(tx, newSupplierOptionId);
        const activeDebit = await this.repository.findActiveGiftCardDebit(tx, giftCardId);

        if (!activeDebit) {
          const updated = await this.repository.updateGiftCardSupplier(tx, {
            giftCardId,
            supplierOptionId: newSupplier.id,
            supplierName: newSupplier.name,
            operatorId: operator?.id
          });
          await this.writeAudit(tx, {
            operator,
            action: 'id_business_v2.gift_card.supplier_reassign',
            objectType: 'id_business_v2_gift_card',
            objectId: giftCardId,
            beforeData: { supplierOptionId: giftCard.supplierOptionId },
            afterData: {
              supplierOptionId: newSupplier.id,
              financialTransferApplied: false,
              reason
            },
            remark: `更正切账前礼品卡供应商：${giftCard.codeMasked}`
          });
          return {
            giftCardId: updated.id,
            supplier: newSupplier,
            legacyCutoverRecord: true,
            oldSupplierBalance: null,
            newSupplierBalance: null,
            idempotentReplay: false
          };
        }

        const newAccountRecord = await this.repository.findSupplierAccountRecord(
          tx,
          newSupplierOptionId
        );
        if (!newAccountRecord?.initializedAt) {
          throw new ConflictException('新供应商资金账户尚未初始化');
        }
        const locked = await this.lockSupplierAccountsByIds(tx, [
          activeDebit.supplierAccountId,
          newAccountRecord.id
        ]);
        const oldAccount = locked.get(activeDebit.supplierAccountId);
        const newAccount = locked.get(newAccountRecord.id);
        if (!oldAccount || !newAccount) {
          throw new ConflictException('供应商资金账户状态已变化，请刷新后重试');
        }

        const activeDebitAmountCny = activeDebit.amountCny;
        const oldAfter = oldAccount.currentBalanceCny.add(activeDebitAmountCny);
        const newAfter = newAccount.currentBalanceCny.sub(activeDebitAmountCny);
        await this.repository.createLedger(tx, {
          supplierAccountId: oldAccount.id,
          giftCardId,
          entryType: 'gift_card_withdrawal_reversal',
          direction: 'credit',
          ...this.cnyLedgerAmounts(activeDebitAmountCny, oldAccount.currentBalanceCny, oldAfter),
          supplierNameSnapshot: oldAccount.supplierName,
          reversalOfEntryId: activeDebit.id,
          idempotencyKey: outgoingKey,
          reason: `供应商更正返还：${reason}`,
          createdByUserId: operator?.id
        });
        await this.repository.createLedger(tx, {
          supplierAccountId: newAccount.id,
          giftCardId,
          entryType: 'gift_card_debit',
          direction: 'debit',
          ...this.cnyLedgerAmounts(activeDebitAmountCny, newAccount.currentBalanceCny, newAfter),
          supplierNameSnapshot: newAccount.supplierName,
          idempotencyKey: incomingKey,
          reason: `供应商更正扣款：${reason}`,
          createdByUserId: operator?.id
        });
        await Promise.all([
          this.repository.updateSupplierAccountBalances(tx, {
            accountId: oldAccount.id,
            currentBalance: oldAfter.toString(),
            currentBalanceCny: oldAfter.toString(),
            operatorId: operator?.id
          }),
          this.repository.updateSupplierAccountBalances(tx, {
            accountId: newAccount.id,
            currentBalance: newAfter.toString(),
            currentBalanceCny: newAfter.toString(),
            operatorId: operator?.id
          })
        ]);
        await this.repository.updateGiftCardSupplier(tx, {
          giftCardId,
          supplierOptionId: newSupplier.id,
          supplierName: newSupplier.name,
          operatorId: operator?.id
        });
        await this.writeAudit(tx, {
          operator,
          action: 'id_business_v2.gift_card.supplier_reassign',
          objectType: 'id_business_v2_gift_card',
          objectId: giftCardId,
          beforeData: {
            supplierOptionId: giftCard.supplierOptionId,
            supplierBalanceCny: oldAccount.currentBalanceCny.toString()
          },
          afterData: {
            supplierOptionId: newSupplier.id,
            oldSupplierBalanceCny: oldAfter.toString(),
            newSupplierBalanceCny: newAfter.toString(),
            transferredCny: activeDebitAmountCny.toString(),
            reason
          },
          remark: `更正礼品卡供应商并转移资金：${giftCard.codeMasked}`
        });
        return {
          giftCardId,
          supplier: newSupplier,
          legacyCutoverRecord: false,
          oldSupplierBalance: {
            supplierOptionId: oldAccount.supplierOptionId,
            beforeCny: oldAccount.currentBalanceCny.toString(),
            afterCny: oldAfter.toString()
          },
          newSupplierBalance: {
            supplierOptionId: newAccount.supplierOptionId,
            beforeCny: newAccount.currentBalanceCny.toString(),
            afterCny: newAfter.toString(),
            isNegative: newAfter.isNegative()
          },
          idempotentReplay: false
        };
      },
      { changedScopes: ['supplier-funds'], requestId: randomUUID(), operator }
    );
  }
}
