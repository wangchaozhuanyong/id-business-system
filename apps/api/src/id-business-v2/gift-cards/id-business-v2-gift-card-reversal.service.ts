import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import type { AuthenticatedUser } from '../../auth/auth.types';
import { IdBusinessV2AccountLossesService } from '../accounts/public-api';
import { IdBusinessV2BalanceCalculatorService } from '../balances/public-api';
import { IdBusinessV2FinancePostingService } from '../finance/public-api';
import {
  Amount4,
  V2CommandTransactionManager,
  type V2CommandTransaction
} from '../runtime/public-api';
import { IdBusinessV2TopupSupplierGiftCardFundsService } from '../topup-supplier-funds/public-api';
import type {
  IdBusinessV2GiftCardReversalAction,
  ReverseIdBusinessV2GiftCardDto
} from './dto/reverse-id-business-v2-gift-card.dto';
import {
  buildGiftCardReversalResponse,
  writeGiftCardReversalAuditLog
} from './id-business-v2-gift-card-reversal-result';
import type { LockedGiftCardReversalAccountRow } from './id-business-v2-gift-card-reversal.types';
import type {
  GiftCardCreditLedgerRecord,
  GiftCardCreditRecord
} from './id-business-v2-gift-card-credit.types';
import { IdBusinessV2GiftCardsRepository } from './persistence/id-business-v2-gift-cards.repository';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,100}$/;

@Injectable()
export class IdBusinessV2GiftCardReversalService {
  constructor(
    private readonly balanceCalculator: IdBusinessV2BalanceCalculatorService,
    private readonly accountLossesService: IdBusinessV2AccountLossesService,
    private readonly supplierFundsService: IdBusinessV2TopupSupplierGiftCardFundsService,
    private readonly financePostingService: IdBusinessV2FinancePostingService,
    private readonly repository: IdBusinessV2GiftCardsRepository,
    private readonly transactionManager: V2CommandTransactionManager
  ) {}

  async listReversible(accountIdValue: string) {
    const accountId = this.normalizeUuid(accountIdValue, '目标 ID');
    const account = await this.repository.findReversibleAccount(accountId);
    if (!account) {
      throw new NotFoundException('目标 ID 不存在或已停用');
    }

    const giftCards = await this.repository.listReversibleGiftCards(accountId);
    const items = giftCards.slice(0, 100);

    return {
      account,
      items: items.map((giftCard) => ({
        id: giftCard.id,
        cardName: giftCard.cardNameSnapshot,
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
        creditedAt: giftCard.creditedAt,
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
    const reportAccountLoss = this.normalizeReportAccountLoss(dto.reportAccountLoss);
    if (reportAccountLoss && action !== 'redeemed') {
      throw new BadRequestException('只有标记被赎回时才能同时报损 ID');
    }
    if (reportAccountLoss) {
      this.assertAccountLossPermission(operator);
    }
    const accountLossRequestKey = this.buildAccountLossRequestKey(idempotencyKey);

    const execute = async (tx: V2CommandTransaction) => {
      const locator = await this.repository.findGiftCardLocator(tx, giftCardId);
      if (!locator) {
        throw new NotFoundException('礼品卡记录不存在');
      }

      const account = await this.lockAccount(tx, locator.accountId);
      const existingEntry = await this.repository.findCreditReplay(tx, idempotencyKey);
      if (existingEntry?.giftCard) {
        this.assertReplayMatches(existingEntry, giftCardId, entryType, reason);
        const accountLoss = await this.resolveReplayAccountLoss(
          tx,
          account,
          existingEntry.giftCard,
          existingEntry,
          reportAccountLoss,
          accountLossRequestKey,
          reason,
          operator
        );
        await this.postReversalJournal(
          tx,
          action,
          existingEntry.giftCard,
          existingEntry.costAmount,
          reason,
          existingEntry.createdAt,
          operator
        );
        if (action === 'withdrawn') {
          await this.supplierFundsService.reverseGiftCardDebit(tx, {
            giftCardId,
            reason,
            operator
          });
        }
        return buildGiftCardReversalResponse(
          action,
          account,
          existingEntry.giftCard,
          existingEntry,
          true,
          accountLoss
        );
      }
      if (account.lossReportedAt) {
        throw new ConflictException('已报损 ID 永久冻结，不能再处理余额');
      }
      if (account.recordStatus !== 'active') {
        throw new NotFoundException('目标 ID 不存在或已停用');
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

      const originalEntry = await this.repository.findGiftCardCreditEntry(tx, giftCardId);
      if (!originalEntry) {
        throw new ConflictException('礼品卡缺少原入账流水，不能执行反向处理');
      }

      const existingReversal = await this.repository.findReversalForEntry(tx, originalEntry.id);
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

      const ledgerEntry = await this.repository.createCreditLedger(tx, {
        accountId: account.id,
        giftCardId,
        entryType,
        direction: 'debit',
        balanceAmount: snapshot.balanceAmount.toString(),
        costAmount: snapshot.costAmount.toString(),
        balanceBefore: snapshot.balanceBefore.toString(),
        balanceAfter: snapshot.balanceAfter.toString(),
        costBefore: snapshot.costBefore.toString(),
        costAfter: snapshot.costAfter.toString(),
        averageCostBefore: snapshot.averageCostBefore.toString(),
        averageCostAfter: snapshot.averageCostAfter.toString(),
        reversalOfEntryId: originalEntry.id,
        idempotencyKey,
        remark: reason,
        createdByUserId: operator?.id
      });

      const statusChangedAt = ledgerEntry.createdAt;
      const updatedGiftCard = await this.repository.updateMappedGiftCard(tx, giftCardId, {
        status: action,
        statusChangedAt,
        supplierRefundStatus: action === 'withdrawn' ? 'pending' : 'none',
        supplierRefundAmount: action === 'withdrawn' ? snapshot.costAmount.toString() : '0',
        supplierRefundAmountCny: action === 'withdrawn' ? snapshot.costAmount.toString() : '0',
        updatedByUserId: operator?.id
      });

      const updatedAccount = await this.repository.updateCreditAccount(tx, {
        accountId: account.id,
        currentBalance: snapshot.balanceAfter.toString(),
        balanceCostAmount: snapshot.costAfter.toString(),
        updatedByUserId: operator?.id
      });

      const accountLoss = reportAccountLoss
        ? await this.accountLossesService.reportLossInTransaction(
            tx,
            account.id,
            {
              reason,
              expectedCurrentBalance: snapshot.balanceAfter.toString(),
              expectedBalanceCostAmount: snapshot.costAfter.toString(),
              idempotencyKey: accountLossRequestKey
            },
            operator,
            {
              source: 'gift_card_redeemed',
              giftCardId,
              giftCardMasked: updatedGiftCard.codeMasked,
              reversalLedgerEntryId: ledgerEntry.id
            }
          )
        : null;
      await this.postReversalJournal(
        tx,
        action,
        updatedGiftCard,
        snapshot.costAmount,
        reason,
        ledgerEntry.createdAt,
        operator
      );
      if (action === 'withdrawn') {
        await this.supplierFundsService.reverseGiftCardDebit(tx, {
          giftCardId,
          reason,
          operator
        });
      }
      const result = buildGiftCardReversalResponse(
        action,
        updatedAccount,
        updatedGiftCard,
        ledgerEntry,
        false,
        accountLoss
      );
      await writeGiftCardReversalAuditLog(tx, this.repository, result, reason, operator);
      return result;
    };
    return this.transactionManager.execute(execute, {
      requestId: randomUUID(),
      operator,
      retryMode: 'fullReplay',
      idempotencyKey,
      replay: execute,
      uniqueConflictMessage: '礼品卡已经处理或请求已经完成，请刷新后核对'
    });
  }

  private postReversalJournal(
    tx: V2CommandTransaction,
    action: IdBusinessV2GiftCardReversalAction,
    giftCard: { id: string; codeMasked: string },
    costAmount: Amount4,
    reason: string,
    occurredAt: Date,
    operator?: AuthenticatedUser
  ) {
    const redeemed = action === 'redeemed';
    return this.financePostingService.post(tx, {
      journalType: redeemed ? 'gift_card_redemption_loss' : 'gift_card_withdrawal_pending',
      sourceType: 'gift_card',
      sourceId: giftCard.id,
      sourceReference: giftCard.codeMasked,
      occurredAt,
      summary: `${redeemed ? '礼品卡赎回损失' : '礼品卡撤回待退款'}：${giftCard.codeMasked}`,
      metadata: { reason },
      idempotencyKey: `auto:gift_card_${action}:${giftCard.id}`,
      operator,
      lines: [
        {
          accountCode: redeemed ? 'gift_card_redemption_loss' : 'supplier_refund_receivable',
          direction: 'debit',
          currency: 'CNY',
          amountOriginal: costAmount,
          fxRateToCny: 1,
          amountCny: costAmount,
          memo: reason
        },
        {
          accountCode: 'gift_card_inventory',
          direction: 'credit',
          currency: 'CNY',
          amountOriginal: costAmount,
          fxRateToCny: 1,
          amountCny: costAmount,
          memo: '冲减礼品卡余额资产'
        }
      ]
    });
  }

  private async lockAccount(tx: V2CommandTransaction, accountId: string) {
    const account = await this.repository.lockReversalAccount(tx, accountId);
    if (!account) {
      throw new NotFoundException('目标 ID 不存在或已停用');
    }
    return account;
  }

  private async resolveReplayAccountLoss(
    tx: V2CommandTransaction,
    account: LockedGiftCardReversalAccountRow,
    giftCard: Pick<GiftCardCreditRecord, 'id' | 'codeMasked'>,
    ledgerEntry: Pick<GiftCardCreditLedgerRecord, 'id' | 'balanceAfter' | 'costAfter'>,
    reportAccountLoss: boolean,
    accountLossRequestKey: string,
    reason: string,
    operator?: AuthenticatedUser
  ) {
    const linkedLoss = await this.repository.findAccountLossByIdempotencyKey(
      tx,
      this.buildAccountLossIdempotencyKey(account.id, accountLossRequestKey)
    );
    if (Boolean(linkedLoss) !== reportAccountLoss) {
      throw new ConflictException('相同幂等键对应的“同时报损 ID”选项不一致');
    }
    if (!reportAccountLoss) return null;

    return this.accountLossesService.reportLossInTransaction(
      tx,
      account.id,
      {
        reason,
        expectedCurrentBalance: ledgerEntry.balanceAfter.toString(),
        expectedBalanceCostAmount: ledgerEntry.costAfter.toString(),
        idempotencyKey: accountLossRequestKey
      },
      operator,
      {
        source: 'gift_card_redeemed',
        giftCardId: giftCard.id,
        giftCardMasked: giftCard.codeMasked,
        reversalLedgerEntryId: ledgerEntry.id
      }
    );
  }

  private async lockGiftCard(tx: V2CommandTransaction, giftCardId: string) {
    const giftCard = await this.repository.lockGiftCard(tx, giftCardId);
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

  private normalizeReportAccountLoss(value: unknown) {
    if (value === undefined || value === false) return false;
    if (value === true) return true;
    throw new BadRequestException('同时报损 ID 选项无效');
  }

  private assertAccountLossPermission(operator?: AuthenticatedUser) {
    if (
      !operator ||
      (!operator.roles.includes('admin') && !operator.permissions.includes('apple.account.update'))
    ) {
      throw new ForbiddenException('同时报损 ID 还需要 ID 修改权限');
    }
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

  private buildAccountLossRequestKey(reversalIdempotencyKey: string) {
    return `gc-loss-${createHash('sha256').update(reversalIdempotencyKey).digest('hex')}`;
  }

  private buildAccountLossIdempotencyKey(accountId: string, requestKey: string) {
    return `account_loss:${accountId}:${requestKey}`;
  }

  private getEntryType(action: IdBusinessV2GiftCardReversalAction) {
    return action === 'redeemed'
      ? ('gift_card_redeemed' as const)
      : ('gift_card_withdrawal' as const);
  }
}
