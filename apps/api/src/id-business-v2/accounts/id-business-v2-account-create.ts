import { BadRequestException, ConflictException } from '@nestjs/common';
import { Prisma as PrismaNamespace } from '@prisma/client';
import type { Prisma } from '@prisma/client';
import { AuditLogsService } from '../../audit-logs/audit-logs.service';
import type { AuthenticatedUser } from '../../auth/auth.types';
import { FieldEncryptionService } from '../../common/crypto/field-encryption.service';
import { PrismaService } from '../../common/prisma/prisma.service';
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
import type { CreateIdBusinessV2AccountDto } from './dto/create-id-business-v2-account.dto';
import {
  ACCOUNT_INCLUDE,
  assertBalanceAdjustmentPermission,
  maskAppleId,
  maskPhone,
  normalizeAppleId,
  normalizeMoney,
  normalizeNullableString,
  normalizePhone,
  parseRecordStatus,
  toAccountResponse,
  toAuditJson
} from './id-business-v2-account-support';

export interface CreateIdBusinessV2AccountDependencies {
  prisma: PrismaService;
  auditLogsService: AuditLogsService;
  fieldEncryptionService: FieldEncryptionService;
  optionsService: IdBusinessV2OptionsService;
  balanceCalculator: IdBusinessV2BalanceCalculatorService;
  financeFxService: IdBusinessV2FinanceFxService;
  financePostingService: IdBusinessV2FinancePostingService;
}

export async function createIdBusinessV2Account(
  dependencies: CreateIdBusinessV2AccountDependencies,
  dto: CreateIdBusinessV2AccountDto,
  operator?: AuthenticatedUser
) {
  const {
    prisma,
    auditLogsService,
    fieldEncryptionService,
    optionsService,
    balanceCalculator,
    financeFxService,
    financePostingService
  } = dependencies;
  const appleId = normalizeAppleId(dto.appleId, true)!;
  const appleIdHash = fieldEncryptionService.hash(appleId)!;
  await assertAppleIdAvailable(prisma, appleIdHash);

  const [country, status, supplier] = await Promise.all([
    optionsService.requireActiveOption(dto.countryOptionId, 'country', '国家'),
    optionsService.requireActiveOption(dto.statusOptionId, 'id_status', 'ID 状态'),
    optionsService.requireActiveOption(dto.supplierOptionId, 'id_supplier', 'ID 供应商', true)
  ]);
  const phone = normalizePhone(dto.phone);
  const openingBalance = balanceCalculator.normalizeSnapshot(
    dto.currentBalance ?? '0',
    dto.balanceCostAmount ?? '0'
  );
  if (!openingBalance.currentBalance.equals(0) || !openingBalance.balanceCostAmount.equals(0)) {
    assertBalanceAdjustmentPermission(operator);
  }
  const purchaseCurrency = normalizeFinanceCurrency(dto.purchaseCurrency ?? 'CNY', '采购币种');
  const legacyPurchaseCost = new PrismaNamespace.Decimal(
    normalizeMoney(dto.purchaseCost, 'ID 购买成本')
  );
  if (purchaseCurrency !== 'CNY' && dto.purchaseOriginalAmount === undefined) {
    throw new BadRequestException('非人民币采购必须填写原币采购金额');
  }
  const purchaseOriginalAmount =
    dto.purchaseOriginalAmount === undefined
      ? legacyPurchaseCost
      : normalizeFinanceMoney(dto.purchaseOriginalAmount, '原币采购金额', true);
  const purchasedAt = dto.purchasedAt
    ? normalizeFinanceDate(dto.purchasedAt, '采购时间')
    : new Date();
  const manualRate =
    dto.purchaseFxRateToCny === undefined
      ? null
      : normalizeFinanceRate(dto.purchaseFxRateToCny, purchaseCurrency);
  const purchaseRate = await financeFxService.resolve({
    currency: purchaseCurrency,
    occurredAt: purchasedAt,
    fxRateSnapshotId: dto.purchaseFxSnapshotId,
    manualRate,
    manualReason: dto.purchaseManualRateReason,
    operator
  });
  const derivedPurchaseCost = purchaseOriginalAmount
    .mul(purchaseRate.rateToCny)
    .toDecimalPlaces(4, PrismaNamespace.Decimal.ROUND_HALF_UP);
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

  const account = await prisma.$transaction(async (tx) => {
    const created = await tx.idBusinessV2Account.create({
      data: {
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
        currentBalance: openingBalance.currentBalance,
        balanceCostAmount: openingBalance.balanceCostAmount,
        purchaseCost,
        purchaseOriginalAmount,
        purchaseCurrency,
        purchaseFxRateToCny: purchaseRate.rateToCny,
        purchaseFxSnapshotId: purchaseRate.id,
        purchaseFinanceAccountId,
        purchaseSupplierAccountId,
        purchasedAt,
        recordStatus: parseRecordStatus(dto.recordStatus, false) ?? 'active',
        remark: normalizeNullableString(dto.remark),
        createdByUserId: operator?.id,
        updatedByUserId: operator?.id
      },
      include: ACCOUNT_INCLUDE
    });

    if (!openingBalance.currentBalance.equals(0)) {
      await tx.idBusinessV2BalanceLedger.create({
        data: {
          accountId: created.id,
          giftCardId: null,
          orderId: null,
          entryType: 'opening_balance',
          direction: 'credit',
          balanceAmount: openingBalance.currentBalance,
          costAmount: openingBalance.balanceCostAmount,
          balanceBefore: '0',
          balanceAfter: openingBalance.currentBalance,
          costBefore: '0',
          costAfter: openingBalance.balanceCostAmount,
          averageCostBefore: '0',
          averageCostAfter: openingBalance.averageCost,
          reversalOfEntryId: null,
          idempotencyKey: `account-opening:${created.id}`,
          remark: 'ID 新增期初余额',
          createdByUserId: operator?.id
        }
      });
    }

    if (purchaseSupplierAccountId) {
      await debitSupplierWallet({
        tx,
        walletId: purchaseSupplierAccountId,
        currency: purchaseCurrency,
        amount: purchaseOriginalAmount,
        amountCny: purchaseCost,
        accountId: created.id,
        accountMasked: created.appleIdMasked,
        operator
      });
    } else if (purchaseFinanceAccountId) {
      const financeAccount = await tx.idBusinessV2FinanceAccount.findUnique({
        where: { id: purchaseFinanceAccountId }
      });
      if (
        !financeAccount ||
        financeAccount.status !== 'active' ||
        financeAccount.currency !== purchaseCurrency
      ) {
        throw new BadRequestException('采购付款账户不存在、已停用或币种不一致');
      }
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
          amountOriginal: purchaseOriginalAmount,
          fxRateToCny: purchaseRate.rateToCny,
          amountCny: purchaseCost,
          fxRateSnapshotId: purchaseRate.id,
          memo: 'ID 采购成本'
        },
        {
          accountCode: purchaseSupplierAccountId ? 'supplier_prepayment' : 'cash',
          direction: 'credit',
          currency: purchaseCurrency,
          amountOriginal: purchaseOriginalAmount,
          fxRateToCny: purchaseRate.rateToCny,
          amountCny: purchaseCost,
          financeAccountId: purchaseFinanceAccountId,
          supplierAccountId: purchaseSupplierAccountId,
          fxRateSnapshotId: purchaseRate.id,
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
          amountOriginal: openingBalance.balanceCostAmount,
          fxRateToCny: 1,
          amountCny: openingBalance.balanceCostAmount
        },
        {
          accountCode: 'opening_equity',
          direction: 'credit',
          currency: 'CNY',
          amountOriginal: openingBalance.balanceCostAmount,
          fxRateToCny: 1,
          amountCny: openingBalance.balanceCostAmount
        }
      ]
    });
    return created;
  });

  const response = toAccountResponse(account);
  await auditLogsService.create({
    userId: operator?.id,
    module: 'id_business_v2_accounts',
    action: 'id_business_v2.account.create',
    objectType: 'id_business_v2_account',
    objectId: account.id,
    afterData: toAuditJson(response),
    remark: `创建 V2 ID：${account.appleIdMasked}`
  });
  return response;
}

async function debitSupplierWallet(input: {
  tx: Prisma.TransactionClient;
  walletId: string;
  currency: 'CNY' | 'MYR' | 'USDT';
  amount: PrismaNamespace.Decimal;
  amountCny: PrismaNamespace.Decimal;
  accountId: string;
  accountMasked: string;
  operator?: AuthenticatedUser;
}) {
  const wallets = await input.tx.$queryRaw<
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
    WHERE wallet."id" = CAST(${input.walletId} AS UUID)
    FOR UPDATE OF wallet
  `);
  const wallet = wallets[0];
  if (!wallet || wallet.currency !== input.currency) {
    throw new BadRequestException('采购供应商钱包不存在或币种不一致');
  }
  if (wallet.currentBalance.lt(input.amount)) {
    throw new ConflictException('供应商钱包余额不足，不能采购 ID');
  }
  const balanceAfter = wallet.currentBalance.sub(input.amount);
  const balanceAfterCny = wallet.currentBalanceCny.sub(input.amountCny);
  await input.tx.idBusinessV2TopupSupplierLedger.create({
    data: {
      supplierAccountId: wallet.id,
      entryType: 'id_purchase_debit',
      direction: 'debit',
      currency: input.currency,
      amount: input.amount,
      balanceBefore: wallet.currentBalance,
      balanceAfter,
      amountCny: input.amountCny,
      balanceBeforeCny: wallet.currentBalanceCny,
      balanceAfterCny,
      supplierNameSnapshot: wallet.supplierName,
      idempotencyKey: `supplier_id_purchase:${input.accountId}`,
      reason: `采购 ID：${input.accountMasked}`,
      createdByUserId: input.operator?.id
    }
  });
  await input.tx.idBusinessV2TopupSupplierAccount.update({
    where: { id: wallet.id },
    data: {
      currentBalance: balanceAfter,
      currentBalanceCny: balanceAfterCny,
      updatedByUserId: input.operator?.id
    }
  });
}

async function assertAppleIdAvailable(prisma: PrismaService, hash: string) {
  const existing = await prisma.idBusinessV2Account.findFirst({
    where: { appleIdHash: hash },
    select: { id: true }
  });
  if (existing) throw new ConflictException('该 Apple ID 已存在');
}
