import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException
} from '@nestjs/common';
import type { AuthenticatedUser } from '../../auth/auth.types';
import { PrismaService } from '../../common/prisma/prisma.service';
import { roundV2Decimal, toV2DecimalString } from '../decimal-policy';
import type { ReassignIdBusinessV2GiftCardSupplierDto } from './dto/topup-supplier-fund.dto';
import { IdBusinessV2TopupSupplierFundsSupport } from './id-business-v2-topup-supplier-funds-support';

@Injectable()
export class IdBusinessV2TopupSupplierReassignmentService extends IdBusinessV2TopupSupplierFundsSupport {
  constructor(prisma: PrismaService) {
    super(prisma);
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

    return this.prisma.$transaction(async (tx) => {
      const giftCard = await tx.idBusinessV2GiftCard.findUnique({
        where: { id: giftCardId },
        include: { supplierOption: true }
      });
      if (!giftCard) throw new NotFoundException('礼品卡记录不存在');
      const [existingOutgoing, existingIncoming] = await Promise.all([
        tx.idBusinessV2TopupSupplierLedger.findUnique({
          where: { idempotencyKey: outgoingKey },
          include: { supplierAccount: true }
        }),
        tx.idBusinessV2TopupSupplierLedger.findUnique({
          where: { idempotencyKey: incomingKey },
          include: { supplierAccount: true }
        })
      ]);
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
            beforeCny: toV2DecimalString(existingOutgoing.balanceBeforeCny),
            afterCny: toV2DecimalString(existingOutgoing.balanceAfterCny)
          },
          newSupplierBalance: {
            supplierOptionId: existingIncoming.supplierAccount.supplierOptionId,
            beforeCny: toV2DecimalString(existingIncoming.balanceBeforeCny),
            afterCny: toV2DecimalString(existingIncoming.balanceAfterCny),
            isNegative: existingIncoming.balanceAfterCny.lt(0)
          },
          idempotentReplay: true
        };
      }
      if (giftCard.supplierOptionId === newSupplierOptionId) {
        const activeDebit = await tx.idBusinessV2TopupSupplierLedger.findFirst({
          where: {
            giftCardId,
            entryType: 'gift_card_debit',
            reversedBy: null
          },
          select: { id: true }
        });
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
      const activeDebit = await tx.idBusinessV2TopupSupplierLedger.findFirst({
        where: {
          giftCardId,
          entryType: 'gift_card_debit',
          reversedBy: null
        },
        orderBy: { createdAt: 'desc' }
      });

      if (!activeDebit) {
        const updated = await tx.idBusinessV2GiftCard.update({
          where: { id: giftCardId },
          data: {
            supplierOptionId: newSupplier.id,
            supplierNameSnapshot: newSupplier.name,
            updatedByUserId: operator?.id
          }
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

      const newAccountRecord = await tx.idBusinessV2TopupSupplierAccount.findUnique({
        where: {
          supplierOptionId_currency: {
            supplierOptionId: newSupplierOptionId,
            currency: 'CNY'
          }
        }
      });
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

      const oldAfter = roundV2Decimal(oldAccount.currentBalanceCny.add(activeDebit.amountCny));
      const newAfter = roundV2Decimal(newAccount.currentBalanceCny.sub(activeDebit.amountCny));
      await tx.idBusinessV2TopupSupplierLedger.create({
        data: {
          supplierAccountId: oldAccount.id,
          giftCardId,
          entryType: 'gift_card_withdrawal_reversal',
          direction: 'credit',
          ...this.cnyLedgerAmounts(activeDebit.amountCny, oldAccount.currentBalanceCny, oldAfter),
          supplierNameSnapshot: oldAccount.supplierName,
          reversalOfEntryId: activeDebit.id,
          idempotencyKey: outgoingKey,
          reason: `供应商更正返还：${reason}`,
          createdByUserId: operator?.id
        }
      });
      await tx.idBusinessV2TopupSupplierLedger.create({
        data: {
          supplierAccountId: newAccount.id,
          giftCardId,
          entryType: 'gift_card_debit',
          direction: 'debit',
          ...this.cnyLedgerAmounts(activeDebit.amountCny, newAccount.currentBalanceCny, newAfter),
          supplierNameSnapshot: newAccount.supplierName,
          idempotencyKey: incomingKey,
          reason: `供应商更正扣款：${reason}`,
          createdByUserId: operator?.id
        }
      });
      await Promise.all([
        tx.idBusinessV2TopupSupplierAccount.update({
          where: { id: oldAccount.id },
          data: {
            currentBalance: oldAfter,
            currentBalanceCny: oldAfter,
            updatedByUserId: operator?.id
          }
        }),
        tx.idBusinessV2TopupSupplierAccount.update({
          where: { id: newAccount.id },
          data: {
            currentBalance: newAfter,
            currentBalanceCny: newAfter,
            updatedByUserId: operator?.id
          }
        })
      ]);
      await tx.idBusinessV2GiftCard.update({
        where: { id: giftCardId },
        data: {
          supplierOptionId: newSupplier.id,
          supplierNameSnapshot: newSupplier.name,
          updatedByUserId: operator?.id
        }
      });
      await this.writeAudit(tx, {
        operator,
        action: 'id_business_v2.gift_card.supplier_reassign',
        objectType: 'id_business_v2_gift_card',
        objectId: giftCardId,
        beforeData: {
          supplierOptionId: giftCard.supplierOptionId,
          supplierBalanceCny: toV2DecimalString(oldAccount.currentBalanceCny)
        },
        afterData: {
          supplierOptionId: newSupplier.id,
          oldSupplierBalanceCny: toV2DecimalString(oldAfter),
          newSupplierBalanceCny: toV2DecimalString(newAfter),
          transferredCny: toV2DecimalString(activeDebit.amountCny),
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
          beforeCny: toV2DecimalString(oldAccount.currentBalanceCny),
          afterCny: toV2DecimalString(oldAfter)
        },
        newSupplierBalance: {
          supplierOptionId: newAccount.supplierOptionId,
          beforeCny: toV2DecimalString(newAccount.currentBalanceCny),
          afterCny: toV2DecimalString(newAfter),
          isNegative: newAfter.lt(0)
        },
        idempotentReplay: false
      };
    });
  }
}
