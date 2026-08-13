import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  Optional
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { AuthenticatedUser } from '../../auth/auth.types';
import { FieldEncryptionService } from '../../common/crypto/field-encryption.service';
import { IdBusinessV2BalanceCalculatorService } from '../balances/public-api';
import { IdBusinessV2ExchangeRateQueryService } from '../exchange-rates/public-api';
import {
  IdBusinessV2FinanceFxService,
  IdBusinessV2FinancePostingService,
  normalizeFinanceCurrency,
  normalizeFinanceDate,
  normalizeFinanceMoney,
  normalizeFinanceRate,
  normalizeOptionalFinanceUuid
} from '../finance/public-api';
import {
  Amount4,
  Rate8,
  V2CommandTransactionManager,
  type V2CommandTransaction
} from '../runtime/public-api';
import { IdBusinessV2TopupSupplierGiftCardFundsService } from '../topup-supplier-funds/public-api';
import type { ConfirmIdBusinessV2GiftCardCreditDto } from './dto/confirm-id-business-v2-gift-card-credit.dto';
import type {
  CreditAuditContext,
  CreditResponse,
  CreditTransactionHook,
  GiftCardCreditRecord
} from './id-business-v2-gift-card-credit.types';
import {
  assertGiftCardCreditReplayMatches,
  buildGiftCardCreditIdempotencyKey,
  giftCardCodeTail,
  maskGiftCardCode,
  normalizeGiftCardCode,
  normalizeGiftCardCreditIdempotencyKey,
  normalizeGiftCardCreditRemark,
  normalizeGiftCardCreditUuid,
  toGiftCardCreditResponse,
  writeGiftCardCreditAuditLogs
} from './id-business-v2-gift-card-credit-support';
import { IdBusinessV2GiftCardsRepository } from './persistence/id-business-v2-gift-cards.repository';

@Injectable()
export class IdBusinessV2GiftCardCreditService {
  constructor(
    private readonly fieldEncryptionService: FieldEncryptionService,
    private readonly balanceCalculator: IdBusinessV2BalanceCalculatorService,
    private readonly exchangeRateQueryService: IdBusinessV2ExchangeRateQueryService,
    private readonly supplierFundsService: IdBusinessV2TopupSupplierGiftCardFundsService,
    private readonly financePostingService: IdBusinessV2FinancePostingService,
    @Optional() private readonly financeFxService: IdBusinessV2FinanceFxService | undefined,
    private readonly repository: IdBusinessV2GiftCardsRepository,
    private readonly transactionManager: V2CommandTransactionManager
  ) {}

  async confirmCredit(
    accountIdValue: string,
    dto: ConfirmIdBusinessV2GiftCardCreditDto,
    operator?: AuthenticatedUser,
    auditContext?: CreditAuditContext,
    transactionHook?: CreditTransactionHook
  ) {
    const accountId = normalizeGiftCardCreditUuid(accountIdValue, '目标 ID');
    const code = normalizeGiftCardCode(dto.code);
    const codeHash = this.fieldEncryptionService.hash(code);
    const codeEncrypted = this.fieldEncryptionService.encrypt(code);
    if (!codeHash || !codeEncrypted) {
      throw new BadRequestException('礼品卡号不能为空');
    }

    const supplierOptionId = normalizeGiftCardCreditUuid(dto.supplierOptionId, '加卡供应商');
    const requestedCardNameOptionId = dto.cardNameOptionId
      ? normalizeGiftCardCreditUuid(dto.cardNameOptionId, '卡片名称')
      : undefined;
    const requestedCountryOptionId = dto.countryOptionId
      ? normalizeGiftCardCreditUuid(dto.countryOptionId, '卡片国家')
      : undefined;
    const confirmedSoldByOrderId = dto.confirmedSoldByOrderId
      ? normalizeGiftCardCreditUuid(dto.confirmedSoldByOrderId, '已售 ID 来源订单')
      : null;
    const idempotencyKey = buildGiftCardCreditIdempotencyKey(
      accountId,
      normalizeGiftCardCreditIdempotencyKey(dto.idempotencyKey)
    );
    const remark = normalizeGiftCardCreditRemark(dto.remark);
    const faceValue = this.balanceCalculator.calculateGiftCardCredit(
      { currentBalance: 0, balanceCostAmount: 0 },
      dto.faceValue,
      1
    ).balanceAmount;
    const hasPurchaseEvidence =
      dto.purchaseOriginalAmount !== undefined ||
      dto.purchaseCurrency !== undefined ||
      dto.purchaseFxRateToCny !== undefined ||
      dto.purchaseFxSnapshotId !== undefined ||
      dto.purchaseFinanceAccountId !== undefined ||
      dto.purchaseSupplierAccountId !== undefined ||
      dto.paidAt !== undefined;
    const purchaseCurrency = normalizeFinanceCurrency(
      dto.purchaseCurrency ?? 'CNY',
      '礼品卡付款币种'
    );
    const creditedAt = dto.creditedAt
      ? normalizeFinanceDate(dto.creditedAt, '加卡时间')
      : new Date();
    const paidAt = dto.paidAt ? normalizeFinanceDate(dto.paidAt, '礼品卡付款时间') : null;
    const purchaseFinanceAccountId = normalizeOptionalFinanceUuid(
      dto.purchaseFinanceAccountId,
      '礼品卡付款账户'
    );
    const purchaseSupplierAccountId = normalizeOptionalFinanceUuid(
      dto.purchaseSupplierAccountId,
      '礼品卡供应商钱包'
    );
    if (purchaseFinanceAccountId && purchaseSupplierAccountId) {
      throw new BadRequestException('礼品卡付款账户和供应商钱包只能选择一种');
    }
    if (hasPurchaseEvidence && !purchaseFinanceAccountId && !purchaseSupplierAccountId) {
      throw new BadRequestException('请选择礼品卡实际付款账户或供应商钱包');
    }

    let purchaseOriginalAmount: Amount4;
    let purchaseFxRateToCny: Rate8;
    let purchaseFxSnapshotId: string | null;
    let purchaseCost: Amount4;
    let effectiveCardRate: Rate8;
    let exchangeRateAudit: Awaited<ReturnType<typeof this.resolveExchangeRateAudit>>;

    if (hasPurchaseEvidence) {
      if (dto.purchaseOriginalAmount === undefined) {
        throw new BadRequestException('礼品卡原币付款金额不能为空');
      }
      if (!this.financeFxService) {
        throw new BadRequestException('财务汇率服务不可用，暂时不能记录多币种礼品卡');
      }
      purchaseOriginalAmount = Amount4.from(
        normalizeFinanceMoney(dto.purchaseOriginalAmount, '礼品卡原币付款金额')
      );
      const purchaseRate = await this.financeFxService.resolve({
        currency: purchaseCurrency,
        occurredAt: paidAt ?? creditedAt,
        fxRateSnapshotId: dto.purchaseFxSnapshotId,
        manualRate:
          dto.purchaseFxRateToCny === undefined
            ? null
            : normalizeFinanceRate(dto.purchaseFxRateToCny, purchaseCurrency),
        manualReason: dto.purchaseManualRateReason,
        operator
      });
      purchaseFxRateToCny = Rate8.from(purchaseRate.rateToCny);
      purchaseFxSnapshotId = purchaseRate.id;
      purchaseCost = purchaseFxRateToCny.apply(purchaseOriginalAmount);
      effectiveCardRate = purchaseCost.ratio(faceValue);
      exchangeRateAudit = {
        exchangeRateSource: 'system_derived_purchase_cost',
        exchangeRateSnapshotId: null,
        exchangeRatePrefilledValue: null,
        exchangeRateWasOverridden: false
      };
    } else {
      if (dto.exchangeRate === undefined) {
        throw new BadRequestException('卡片汇率不能为空');
      }
      const legacySnapshot = this.balanceCalculator.calculateGiftCardCredit(
        { currentBalance: 0, balanceCostAmount: 0 },
        faceValue,
        dto.exchangeRate
      );
      purchaseOriginalAmount = legacySnapshot.costAmount;
      purchaseFxRateToCny = Rate8.one();
      purchaseFxSnapshotId = null;
      purchaseCost = legacySnapshot.costAmount;
      effectiveCardRate = legacySnapshot.exchangeRate;
      exchangeRateAudit = await this.resolveExchangeRateAudit(dto);
    }

    const execute = async (tx: V2CommandTransaction) => {
      const account = await this.lockAccount(tx, accountId);
      if (
        requestedCountryOptionId !== undefined &&
        requestedCountryOptionId !== account.countryOptionId
      ) {
        throw new ConflictException('卡片国家必须与目标 ID 当前国家一致，请刷新后重新提交');
      }
      const existingEntry = await this.repository.findCreditReplay(tx, idempotencyKey);

      if (existingEntry?.giftCard) {
        if (account.lossReportedAt) {
          throw new ConflictException('已报损冻结 ID 不能继续加卡');
        }
        assertGiftCardCreditReplayMatches(this.balanceCalculator, existingEntry.giftCard, {
          accountId,
          cardNameOptionId: requestedCardNameOptionId,
          countryOptionId: requestedCountryOptionId,
          creditedAt: dto.creditedAt ? creditedAt : undefined,
          codeHash,
          faceValue,
          exchangeRate: effectiveCardRate,
          exchangeRateAudit,
          supplierOptionId,
          remark
        });
        const storedPurchaseOriginalAmount =
          existingEntry.giftCard.purchaseOriginalAmount ?? existingEntry.giftCard.costAmount;
        const storedPurchaseCurrency = existingEntry.giftCard.purchaseCurrency ?? 'CNY';
        const storedPurchaseFxRate = existingEntry.giftCard.purchaseFxRateToCny;
        const storedFinanceAccountId = existingEntry.giftCard.purchaseFinanceAccountId ?? null;
        const storedSupplierAccountId = existingEntry.giftCard.purchaseSupplierAccountId ?? null;
        if (
          storedPurchaseCurrency !== purchaseCurrency ||
          !storedPurchaseOriginalAmount.equals(purchaseOriginalAmount) ||
          !storedPurchaseFxRate.equals(purchaseFxRateToCny) ||
          storedFinanceAccountId !== purchaseFinanceAccountId ||
          (hasPurchaseEvidence && storedSupplierAccountId !== purchaseSupplierAccountId)
        ) {
          throw new ConflictException('幂等键已用于不同的礼品卡入账证据');
        }
        const supplierFunding =
          storedSupplierAccountId || !storedFinanceAccountId
            ? await this.supplierFundsService.debitGiftCard(tx, {
                supplierOptionId,
                supplierAccountId: storedSupplierAccountId ?? undefined,
                giftCardId: existingEntry.giftCard.id,
                currency: storedPurchaseCurrency,
                amountOriginal: storedPurchaseOriginalAmount,
                amountCny: existingEntry.giftCard.costAmount,
                operator
              })
            : null;
        await this.postPurchaseJournal(tx, existingEntry.giftCard, supplierFunding, operator);
        await transactionHook?.({
          tx,
          accountId,
          giftCardId: existingEntry.giftCard.id,
          ledgerEntryId: existingEntry.id,
          idempotentReplay: true
        });
        return toGiftCardCreditResponse(
          account,
          existingEntry.giftCard,
          existingEntry,
          supplierFunding,
          true
        );
      }
      this.assertSoldAccountConfirmation(account.soldByOrderId, confirmedSoldByOrderId);
      if (account.lossReportedAt) {
        throw new ConflictException('已报损冻结 ID 不能继续加卡');
      }
      const { country, cardName, supplier } = await this.repository.findCreditOptions(tx, {
        countryOptionId: account.countryOptionId,
        cardNameOptionId: requestedCardNameOptionId,
        supplierOptionId
      });
      if (!country) {
        throw new BadRequestException('目标 ID 国家不存在或已停用');
      }
      if (!cardName) {
        throw new BadRequestException('卡片名称不存在或已停用，请先到选项设置完成配置');
      }
      if (!supplier) {
        throw new BadRequestException('加卡供应商不存在或已停用');
      }
      if (purchaseFinanceAccountId) {
        const financeAccount = await this.repository.findFinanceAccount(
          tx,
          purchaseFinanceAccountId
        );
        if (
          !financeAccount ||
          financeAccount.status !== 'active' ||
          financeAccount.currency !== purchaseCurrency
        ) {
          throw new BadRequestException('礼品卡付款账户不存在、已停用或币种不一致');
        }
      }

      const duplicateGiftCard = await this.repository.hasGiftCardCodeHash(tx, codeHash);
      if (duplicateGiftCard) {
        throw new ConflictException('礼品卡号已入账，请勿重复使用');
      }

      const snapshot = this.balanceCalculator.calculateGiftCardCredit(
        {
          currentBalance: account.currentBalance,
          balanceCostAmount: account.balanceCostAmount
        },
        faceValue,
        effectiveCardRate
      );
      if (!snapshot.costAmount.equals(purchaseCost)) {
        throw new BadRequestException('礼品卡付款成本无法按单位成本精确分摊，请调整金额');
      }
      const giftCardId = randomUUID();

      const giftCard = await this.repository.createCreditGiftCard(tx, {
        id: giftCardId,
        accountId,
        cardNameOptionId: cardName.id,
        supplierOptionId: supplier.id,
        countryOptionId: account.countryOptionId,
        cardNameSnapshot: cardName.name,
        countryNameSnapshot: account.countryName,
        currencyCodeSnapshot: account.currencyCode,
        supplierNameSnapshot: supplier.name,
        sourceAttachmentId: null,
        codeEncrypted,
        codeHash,
        codeMasked: maskGiftCardCode(code),
        codeTail: giftCardCodeTail(code),
        faceValue: snapshot.balanceAmount.toString(),
        exchangeRate: snapshot.exchangeRate.toString(),
        exchangeRateSource: exchangeRateAudit.exchangeRateSource,
        exchangeRateSnapshotId: exchangeRateAudit.exchangeRateSnapshotId,
        exchangeRatePrefilledValue:
          exchangeRateAudit.exchangeRatePrefilledValue?.toString() ?? null,
        exchangeRateWasOverridden: exchangeRateAudit.exchangeRateWasOverridden,
        costAmount: snapshot.costAmount.toString(),
        purchaseOriginalAmount: purchaseOriginalAmount.toString(),
        purchaseCurrency,
        purchaseFxRateToCny: purchaseFxRateToCny.toString(),
        purchaseFxSnapshotId,
        purchaseFinanceAccountId,
        purchaseSupplierAccountId,
        paidAt,
        status: 'credited',
        statusChangedAt: creditedAt,
        creditedAt,
        remark,
        createdByUserId: operator?.id,
        updatedByUserId: operator?.id
      });

      const ledgerEntry = await this.repository.createCreditLedger(tx, {
        accountId,
        giftCardId: giftCard.id,
        entryType: 'gift_card_credit',
        direction: 'credit',
        balanceAmount: snapshot.balanceAmount.toString(),
        costAmount: snapshot.costAmount.toString(),
        balanceBefore: snapshot.balanceBefore.toString(),
        balanceAfter: snapshot.balanceAfter.toString(),
        costBefore: snapshot.costBefore.toString(),
        costAfter: snapshot.costAfter.toString(),
        averageCostBefore: snapshot.averageCostBefore.toString(),
        averageCostAfter: snapshot.averageCostAfter.toString(),
        reversalOfEntryId: null,
        idempotencyKey,
        remark,
        createdByUserId: operator?.id
      });

      const updatedAccount = await this.repository.updateCreditAccount(tx, {
        accountId,
        currentBalance: snapshot.balanceAfter.toString(),
        balanceCostAmount: snapshot.costAfter.toString(),
        updatedByUserId: operator?.id
      });

      const supplierFunding =
        purchaseSupplierAccountId || !purchaseFinanceAccountId
          ? await this.supplierFundsService.debitGiftCard(tx, {
              supplierOptionId: supplier.id,
              supplierAccountId: purchaseSupplierAccountId ?? undefined,
              giftCardId: giftCard.id,
              currency: purchaseCurrency,
              amountOriginal: purchaseOriginalAmount,
              amountCny: snapshot.costAmount,
              operator
            })
          : null;
      if (supplierFunding && !purchaseSupplierAccountId) {
        await this.repository.updateGiftCard(tx, giftCard.id, {
          purchaseSupplierAccountId: supplierFunding.supplierAccountId
        });
      }
      const journalGiftCard =
        supplierFunding && !purchaseSupplierAccountId
          ? {
              ...giftCard,
              purchaseSupplierAccountId: supplierFunding.supplierAccountId
            }
          : giftCard;
      await this.postPurchaseJournal(tx, journalGiftCard, supplierFunding, operator);
      const result = toGiftCardCreditResponse(
        updatedAccount,
        journalGiftCard,
        ledgerEntry,
        supplierFunding,
        false
      );
      await writeGiftCardCreditAuditLogs(tx, this.repository, result, operator, auditContext);
      await transactionHook?.({
        tx,
        accountId,
        giftCardId: giftCard.id,
        ledgerEntryId: ledgerEntry.id,
        idempotentReplay: false
      });
      return result;
    };

    return this.transactionManager.execute(execute, {
      requestId: randomUUID(),
      operator,
      businessTime: creditedAt,
      retryMode: 'fullReplay',
      idempotencyKey,
      replay: execute,
      uniqueConflictMessage: '礼品卡号已入账或请求已处理，请刷新后核对'
    });
  }

  private assertSoldAccountConfirmation(
    currentSoldByOrderId: string | null,
    confirmedSoldByOrderId: string | null
  ) {
    if (!currentSoldByOrderId && !confirmedSoldByOrderId) return;
    if (!currentSoldByOrderId) {
      throw new ConflictException('该 ID 当前已恢复为未售出，请刷新列表后重新加卡');
    }
    if (!confirmedSoldByOrderId) {
      throw new ConflictException('该 ID 已售出，请确认销售订单和客户归属后重新加卡');
    }
    if (currentSoldByOrderId !== confirmedSoldByOrderId) {
      throw new ConflictException('该 ID 的销售归属已变化，请刷新列表并重新确认后加卡');
    }
  }

  private postPurchaseJournal(
    tx: V2CommandTransaction,
    giftCard: Pick<
      GiftCardCreditRecord,
      | 'id'
      | 'codeMasked'
      | 'costAmount'
      | 'purchaseOriginalAmount'
      | 'purchaseCurrency'
      | 'purchaseFxRateToCny'
      | 'purchaseFxSnapshotId'
      | 'purchaseFinanceAccountId'
      | 'purchaseSupplierAccountId'
      | 'paidAt'
      | 'creditedAt'
    >,
    supplierFunding: CreditResponse['supplierFunding'],
    operator?: AuthenticatedUser
  ) {
    const purchaseOriginalAmount = giftCard.purchaseOriginalAmount;
    const purchaseCostAmount = giftCard.costAmount;
    const purchaseCurrency = giftCard.purchaseCurrency;
    const purchaseFxRateToCny = giftCard.purchaseFxRateToCny;
    return this.financePostingService.post(tx, {
      journalType: 'gift_card_purchase',
      sourceType: 'gift_card',
      sourceId: giftCard.id,
      sourceReference: giftCard.codeMasked,
      occurredAt: giftCard.creditedAt ?? giftCard.paidAt ?? new Date(),
      summary: `礼品卡采购入库：${giftCard.codeMasked}`,
      idempotencyKey: `auto:gift_card_purchase:${giftCard.id}`,
      operator,
      lines: [
        {
          accountCode: 'gift_card_inventory',
          direction: 'debit',
          currency: purchaseCurrency,
          amountOriginal: purchaseOriginalAmount,
          fxRateToCny: purchaseFxRateToCny,
          amountCny: purchaseCostAmount,
          fxRateSnapshotId: giftCard.purchaseFxSnapshotId,
          memo: '礼品卡余额资产'
        },
        {
          accountCode: supplierFunding ? 'supplier_prepayment' : 'cash',
          direction: 'credit',
          currency: purchaseCurrency,
          amountOriginal: purchaseOriginalAmount,
          fxRateToCny: purchaseFxRateToCny,
          amountCny: purchaseCostAmount,
          financeAccountId: giftCard.purchaseFinanceAccountId,
          supplierAccountId: supplierFunding?.supplierAccountId,
          fxRateSnapshotId: giftCard.purchaseFxSnapshotId,
          memo: supplierFunding ? '扣减卡商预付款' : '礼品卡采购付款'
        }
      ]
    });
  }

  private async lockAccount(tx: V2CommandTransaction, accountId: string) {
    const account = await this.repository.lockCreditAccount(tx, accountId);
    if (!account) {
      throw new NotFoundException('目标 ID 不存在或已停用');
    }
    return account;
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
}
