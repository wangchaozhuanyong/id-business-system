import { BadRequestException, ConflictException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { AuthenticatedUser } from '../../auth/auth.types';
import { FieldEncryptionService } from '../../common/crypto/field-encryption.service';
import { IdBusinessV2BalanceCalculatorService } from '../balances/public-api';
import {
  IdBusinessV2FinanceFxService,
  IdBusinessV2FinancePostingService,
  normalizeFinanceCurrency,
  normalizeFinanceDate,
  normalizeFinanceMoney,
  normalizeFinanceRate,
  normalizeOptionalFinanceUuid
} from '../finance/public-api';
import { IdBusinessV2OptionsService } from '../options/public-api';
import {
  Amount4,
  Rate8,
  V2CommandTransactionManager,
  V2TransactionalAuditService,
  toV2JsonDocument
} from '../runtime/public-api';
import type { CreateIdBusinessV2AccountDto } from './dto/create-id-business-v2-account.dto';
import {
  assertBalanceAdjustmentPermission,
  maskAppleId,
  maskPhone,
  normalizeAppleId,
  normalizeMoney,
  normalizeNullableString,
  normalizePhone,
  parseRecordStatus,
  toAccountResponse
} from './id-business-v2-account-support';
import { IdBusinessV2AccountsRepository } from './persistence/id-business-v2-accounts.repository';

export interface CreateIdBusinessV2AccountDependencies {
  repository: IdBusinessV2AccountsRepository;
  fieldEncryptionService: FieldEncryptionService;
  optionsService: IdBusinessV2OptionsService;
  balanceCalculator: IdBusinessV2BalanceCalculatorService;
  financeFxService: IdBusinessV2FinanceFxService;
  financePostingService: IdBusinessV2FinancePostingService;
  transactionManager: V2CommandTransactionManager;
  transactionalAudit: V2TransactionalAuditService;
}

export async function createIdBusinessV2Account(
  dependencies: CreateIdBusinessV2AccountDependencies,
  dto: CreateIdBusinessV2AccountDto,
  operator?: AuthenticatedUser,
  requestId: string = randomUUID()
) {
  const {
    repository,
    fieldEncryptionService,
    optionsService,
    balanceCalculator,
    financeFxService,
    financePostingService,
    transactionManager,
    transactionalAudit
  } = dependencies;
  const appleId = normalizeAppleId(dto.appleId, true)!;
  const appleIdHash = fieldEncryptionService.hash(appleId)!;
  const phone = normalizePhone(dto.phone);
  const openingBalance = balanceCalculator.normalizeSnapshot(
    dto.currentBalance ?? '0',
    dto.balanceCostAmount ?? '0'
  );
  if (!openingBalance.currentBalance.isZero() || !openingBalance.balanceCostAmount.isZero()) {
    assertBalanceAdjustmentPermission(operator);
  }

  const purchaseCurrency = normalizeFinanceCurrency(dto.purchaseCurrency ?? 'CNY', '采购币种');
  const legacyPurchaseCost = Amount4.from(normalizeMoney(dto.purchaseCost, 'ID 购买成本'));
  if (purchaseCurrency !== 'CNY' && dto.purchaseOriginalAmount === undefined) {
    throw new BadRequestException('非人民币采购必须填写原币采购金额');
  }
  const purchaseOriginalAmount =
    dto.purchaseOriginalAmount === undefined
      ? legacyPurchaseCost
      : Amount4.from(
          normalizeFinanceMoney(dto.purchaseOriginalAmount, '原币采购金额', true).toString()
        );
  const purchasedAt = dto.purchasedAt
    ? normalizeFinanceDate(dto.purchasedAt, '采购时间')
    : new Date();
  const manualRate =
    dto.purchaseFxRateToCny === undefined
      ? null
      : normalizeFinanceRate(dto.purchaseFxRateToCny, purchaseCurrency).toString();
  const resolvedRate = await financeFxService.resolve({
    currency: purchaseCurrency,
    occurredAt: purchasedAt,
    fxRateSnapshotId: dto.purchaseFxSnapshotId,
    manualRate,
    manualReason: dto.purchaseManualRateReason,
    operator
  });
  const purchaseRate = Rate8.from(resolvedRate.rateToCny);
  const derivedPurchaseCost = purchaseRate.apply(purchaseOriginalAmount);
  if (
    dto.purchaseCost !== undefined &&
    (dto.purchaseOriginalAmount !== undefined || purchaseCurrency !== 'CNY') &&
    !legacyPurchaseCost.equals(derivedPurchaseCost)
  ) {
    throw new BadRequestException('ID 人民币成本与原币金额、交易汇率计算结果不一致');
  }
  const purchaseCost =
    dto.purchaseOriginalAmount !== undefined || purchaseCurrency !== 'CNY'
      ? derivedPurchaseCost
      : legacyPurchaseCost;
  const purchaseFinanceAccountId = normalizeOptionalFinanceUuid(
    dto.purchaseFinanceAccountId,
    '采购付款账户'
  );
  const purchaseSupplierAccountId = normalizeOptionalFinanceUuid(
    dto.purchaseSupplierAccountId,
    '采购供应商钱包'
  );
  if (purchaseFinanceAccountId && purchaseSupplierAccountId) {
    throw new BadRequestException('采购付款账户和供应商钱包只能选择一种资金来源');
  }

  return transactionManager.execute(
    async (tx) => {
      if (await repository.findByAppleIdHash(appleIdHash, tx)) {
        throw new ConflictException('该 Apple ID 已存在');
      }
      const [country, status, supplier] = await Promise.all([
        optionsService.requireActiveOption(dto.countryOptionId, 'country', '国家', false, tx),
        optionsService.requireActiveOption(dto.statusOptionId, 'id_status', 'ID 状态', false, tx),
        optionsService.requireActiveOption(
          dto.supplierOptionId,
          'id_supplier',
          'ID 供应商',
          true,
          tx
        )
      ]);
      await repository.assertFxSnapshot(tx, {
        id: resolvedRate.id,
        currency: purchaseCurrency,
        rate: purchaseRate,
        occurredAt: purchasedAt
      });

      const supplierWallet = purchaseSupplierAccountId
        ? await repository.lockSupplierWallet(tx, purchaseSupplierAccountId)
        : null;
      if (purchaseSupplierAccountId) {
        if (!supplierWallet || supplierWallet.currency !== purchaseCurrency) {
          throw new BadRequestException('采购供应商钱包不存在或币种不一致');
        }
        if (supplierWallet.currentBalance.lt(purchaseOriginalAmount)) {
          throw new ConflictException('供应商钱包余额不足，不能采购 ID');
        }
      }
      if (purchaseFinanceAccountId) {
        await repository.assertFinanceAccountCurrency(
          tx,
          purchaseFinanceAccountId,
          purchaseCurrency
        );
      }

      const created = await repository.create(tx, {
        appleIdEncrypted: fieldEncryptionService.encrypt(appleId)!,
        appleIdHash,
        appleIdMasked: maskAppleId(appleId),
        passwordEncrypted: fieldEncryptionService.encrypt(normalizeNullableString(dto.password)),
        phoneEncrypted: fieldEncryptionService.encrypt(phone),
        phoneHash: fieldEncryptionService.hash(phone),
        phoneMasked: maskPhone(phone),
        phoneTail: phone ? phone.slice(-8) : null,
        securityInfoEncrypted: fieldEncryptionService.encrypt(
          normalizeNullableString(dto.securityInfo)
        ),
        countryOptionId: country!.id,
        statusOptionId: status!.id,
        supplierOptionId: supplier?.id ?? null,
        currentBalance: openingBalance.currentBalance.toString(),
        balanceCostAmount: openingBalance.balanceCostAmount.toString(),
        purchaseCost: purchaseCost.toString(),
        purchaseOriginalAmount: purchaseOriginalAmount.toString(),
        purchaseCurrency,
        purchaseFxRateToCny: purchaseRate.toString(),
        purchaseFxSnapshotId: resolvedRate.id,
        purchaseFinanceAccountId,
        purchaseSupplierAccountId,
        purchasedAt,
        recordStatus: parseRecordStatus(dto.recordStatus, false) ?? 'active',
        remark: normalizeNullableString(dto.remark),
        createdByUserId: operator?.id,
        updatedByUserId: operator?.id
      });

      if (!openingBalance.currentBalance.isZero()) {
        await repository.appendOpeningBalance(tx, {
          accountId: created.id,
          balance: openingBalance.currentBalance,
          cost: openingBalance.balanceCostAmount,
          averageCost: openingBalance.averageCost,
          operatorId: operator?.id
        });
      }
      if (supplierWallet) {
        await repository.debitSupplierWallet(tx, {
          wallet: supplierWallet,
          amount: purchaseOriginalAmount,
          amountCny: purchaseCost,
          accountId: created.id,
          accountMasked: created.appleIdMasked,
          operatorId: operator?.id
        });
      }

      await financePostingService.post(tx, {
        journalType: 'account_purchase',
        sourceType: 'account',
        sourceId: created.id,
        sourceReference: created.appleIdMasked,
        occurredAt: purchasedAt,
        summary: `ID 采购入库：${created.appleIdMasked}`,
        idempotencyKey: `auto:account_purchase:${created.id}`,
        operator,
        lines: [
          {
            accountCode: 'id_inventory',
            direction: 'debit',
            currency: purchaseCurrency,
            amountOriginal: purchaseOriginalAmount.toString(),
            fxRateToCny: purchaseRate.toString(),
            amountCny: purchaseCost.toString(),
            fxRateSnapshotId: resolvedRate.id,
            memo: 'ID 采购成本'
          },
          {
            accountCode: purchaseSupplierAccountId ? 'supplier_prepayment' : 'cash',
            direction: 'credit',
            currency: purchaseCurrency,
            amountOriginal: purchaseOriginalAmount.toString(),
            fxRateToCny: purchaseRate.toString(),
            amountCny: purchaseCost.toString(),
            financeAccountId: purchaseFinanceAccountId,
            supplierAccountId: purchaseSupplierAccountId,
            fxRateSnapshotId: resolvedRate.id,
            memo: purchaseSupplierAccountId ? '扣减供应商预付款' : 'ID 采购付款'
          }
        ]
      });
      await financePostingService.post(tx, {
        journalType: 'opening_balance',
        sourceType: 'opening_balance',
        sourceId: created.id,
        sourceReference: created.appleIdMasked,
        occurredAt: created.createdAt,
        summary: `ID 期初余额资产：${created.appleIdMasked}`,
        metadata: { excludedFromProfit: true },
        idempotencyKey: `auto:account_balance_opening:${created.id}`,
        operator,
        lines: [
          {
            accountCode: 'gift_card_inventory',
            direction: 'debit',
            currency: 'CNY',
            amountOriginal: openingBalance.balanceCostAmount.toString(),
            fxRateToCny: '1',
            amountCny: openingBalance.balanceCostAmount.toString()
          },
          {
            accountCode: 'opening_equity',
            direction: 'credit',
            currency: 'CNY',
            amountOriginal: openingBalance.balanceCostAmount.toString(),
            fxRateToCny: '1',
            amountCny: openingBalance.balanceCostAmount.toString()
          }
        ]
      });

      const response = toAccountResponse(created);
      await transactionalAudit.append(tx, {
        userId: operator?.id,
        module: 'id_business_v2_accounts',
        action: 'id_business_v2.account.create',
        objectType: 'id_business_v2_account',
        objectId: created.id,
        afterData: toV2JsonDocument(response),
        remark: `创建 V2 ID：${created.appleIdMasked}`
      });
      return response;
    },
    {
      requestId,
      operator,
      uniqueConflictMessage: '该 Apple ID 已存在或采购记录已创建'
    }
  );
}
