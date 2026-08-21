import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { verifySensitiveAccessApproval } from '../../../common/sensitive-access-approval';
import {
  buildV2StringArrayContainsFilter,
  mapAmount4,
  mapRate8,
  type V2CommandTransaction
} from '../../runtime/public-api';
import type {
  GiftCardCreditAccountRecord,
  GiftCardCreditLedgerRecord,
  GiftCardCreditRecord,
  LockedGiftCardCreditAccountRow
} from '../id-business-v2-gift-card-credit.types';
import type {
  BalanceLedgerRecord,
  GiftCardRecord,
  IdBusinessV2BalanceLedgerEntryType,
  IdBusinessV2GiftCardStatus
} from '../id-business-v2-gift-card-record-includes';
import type {
  LockedGiftCardReversalAccountRow,
  LockedGiftCardReversalRow
} from '../id-business-v2-gift-card-reversal.types';

const GIFT_CARD_RECORD_INCLUDE = {
  cardNameOption: { select: { id: true, code: true, name: true } },
  account: {
    select: {
      id: true,
      appleIdEncrypted: true,
      appleIdMasked: true,
      lossReportedAt: true,
      countryOption: { select: { id: true, code: true, name: true } }
    }
  },
  supplierOption: { select: { id: true, code: true, name: true } },
  countryOption: { select: { id: true, code: true } },
  createdBy: { select: { id: true, username: true, displayName: true } },
  updatedBy: { select: { id: true, username: true, displayName: true } },
  ledgerEntries: {
    where: { entryType: 'gift_card_credit' as const },
    select: {
      id: true,
      balanceBefore: true,
      balanceAfter: true,
      costBefore: true,
      costAfter: true,
      averageCostBefore: true,
      averageCostAfter: true,
      createdAt: true,
      reversedByEntry: {
        select: {
          id: true,
          entryType: true,
          balanceAmount: true,
          costAmount: true,
          remark: true,
          createdAt: true
        }
      }
    },
    take: 1
  },
  supplierFundEntries: {
    where: { entryType: 'gift_card_debit' as const },
    select: { id: true },
    orderBy: { createdAt: 'desc' as const },
    take: 1
  }
} satisfies Prisma.IdBusinessV2GiftCardInclude;

const BALANCE_LEDGER_INCLUDE = {
  account: {
    select: {
      id: true,
      appleIdEncrypted: true,
      appleIdMasked: true,
      countryOption: { select: { id: true, code: true, name: true } }
    }
  },
  giftCard: {
    select: {
      id: true,
      codeEncrypted: true,
      codeMasked: true,
      codeTail: true,
      faceValue: true,
      status: true,
      supplierOption: { select: { id: true, code: true, name: true } }
    }
  },
  reversalOfEntry: { select: { id: true, entryType: true, createdAt: true } },
  reversedByEntry: { select: { id: true, entryType: true, createdAt: true } },
  createdBy: { select: { id: true, username: true, displayName: true } }
} satisfies Prisma.IdBusinessV2BalanceLedgerInclude;

type GiftCardPersistenceRow = Prisma.IdBusinessV2GiftCardGetPayload<{
  include: typeof GIFT_CARD_RECORD_INCLUDE;
}>;
type BalanceLedgerPersistenceRow = Prisma.IdBusinessV2BalanceLedgerGetPayload<{
  include: typeof BALANCE_LEDGER_INCLUDE;
}>;

export interface GiftCardListCriteria {
  keyword: string | null;
  codeSearchTokens: string[];
  accountId: string | null;
  cardNameOptionId: string | null;
  countryOptionId: string | null;
  supplierOptionId: string | null;
  status: IdBusinessV2GiftCardStatus | null;
  creditedAt?: { gte?: Date; lte?: Date };
  sortField: string;
  sortDirection: 'asc' | 'desc';
  skip: number;
  take: number;
}

export interface BalanceLedgerListCriteria {
  keyword: string | null;
  codeSearchTokens: string[];
  accountId: string | null;
  countryOptionId: string | null;
  supplierOptionId: string | null;
  entryType: IdBusinessV2BalanceLedgerEntryType | null;
  createdAt?: { gte?: Date; lte?: Date };
  sortField: string;
  sortDirection: 'asc' | 'desc';
  skip: number;
  take: number;
}

@Injectable()
export class IdBusinessV2GiftCardsRepository {
  constructor(private readonly prisma: PrismaService) {}

  appendAudit(tx: V2CommandTransaction, data: Prisma.AuditLogUncheckedCreateInput) {
    return tx.auditLog.create({ data });
  }

  async listGiftCards(criteria: GiftCardListCriteria) {
    const where: Prisma.IdBusinessV2GiftCardWhereInput = {
      accountId: criteria.accountId ?? undefined,
      cardNameOptionId: criteria.cardNameOptionId ?? undefined,
      supplierOptionId: criteria.supplierOptionId ?? undefined,
      countryOptionId: criteria.countryOptionId ?? undefined,
      status: criteria.status ?? undefined,
      creditedAt: criteria.creditedAt,
      OR: criteria.keyword
        ? [
            { cardNameSnapshot: { contains: criteria.keyword } },
            { codeMasked: { contains: criteria.keyword } },
            { codeTail: { contains: criteria.keyword.slice(-8) } },
            {
              codeSearchTokens: buildV2StringArrayContainsFilter(criteria.codeSearchTokens)
            },
            {
              account: {
                is: { appleIdMasked: { contains: criteria.keyword } }
              }
            },
            {
              supplierOption: {
                is: { name: { contains: criteria.keyword } }
              }
            }
          ]
        : undefined
    };
    const [rows, total] = await Promise.all([
      this.prisma.idBusinessV2GiftCard.findMany({
        where,
        include: GIFT_CARD_RECORD_INCLUDE,
        skip: criteria.skip,
        take: criteria.take,
        orderBy: [{ [criteria.sortField]: criteria.sortDirection }, { id: 'desc' }]
      }),
      this.prisma.idBusinessV2GiftCard.count({ where })
    ]);
    return { items: rows.map(mapGiftCardRecord), total };
  }

  async listBalanceLedger(criteria: BalanceLedgerListCriteria) {
    const where: Prisma.IdBusinessV2BalanceLedgerWhereInput = {
      accountId: criteria.accountId ?? undefined,
      entryType: criteria.entryType ?? undefined,
      createdAt: criteria.createdAt,
      account: criteria.countryOptionId
        ? { is: { countryOptionId: criteria.countryOptionId } }
        : undefined,
      giftCard: criteria.supplierOptionId
        ? { is: { supplierOptionId: criteria.supplierOptionId } }
        : undefined,
      OR: criteria.keyword
        ? [
            {
              account: {
                is: { appleIdMasked: { contains: criteria.keyword } }
              }
            },
            {
              giftCard: {
                is: { codeMasked: { contains: criteria.keyword } }
              }
            },
            {
              giftCard: {
                is: { codeTail: { contains: criteria.keyword.slice(-8) } }
              }
            },
            {
              giftCard: {
                is: {
                  codeSearchTokens: buildV2StringArrayContainsFilter(criteria.codeSearchTokens)
                }
              }
            },
            {
              giftCard: {
                is: {
                  supplierOption: {
                    is: { name: { contains: criteria.keyword } }
                  }
                }
              }
            }
          ]
        : undefined
    };
    const [rows, total] = await Promise.all([
      this.prisma.idBusinessV2BalanceLedger.findMany({
        where,
        include: BALANCE_LEDGER_INCLUDE,
        skip: criteria.skip,
        take: criteria.take,
        orderBy: [{ [criteria.sortField]: criteria.sortDirection }, { id: 'desc' }]
      }),
      this.prisma.idBusinessV2BalanceLedger.count({ where })
    ]);
    return { items: rows.map(mapBalanceLedgerRecord), total };
  }

  async findReversibleAccount(accountId: string) {
    return this.prisma.idBusinessV2Account.findFirst({
      where: {
        id: accountId,
        deletedAt: null,
        recordStatus: 'active',
        lossReportedAt: null
      },
      select: { id: true, appleIdMasked: true }
    });
  }

  async listReversibleGiftCards(accountId: string) {
    const rows = await this.prisma.idBusinessV2GiftCard.findMany({
      where: {
        accountId,
        status: 'credited',
        ledgerEntries: { some: { entryType: 'gift_card_credit' } }
      },
      select: {
        id: true,
        cardNameSnapshot: true,
        codeEncrypted: true,
        codeMasked: true,
        codeTail: true,
        faceValue: true,
        exchangeRate: true,
        costAmount: true,
        status: true,
        creditedAt: true,
        createdAt: true,
        supplierOption: { select: { id: true, name: true } },
        ledgerEntries: {
          where: { entryType: 'gift_card_credit' },
          select: { id: true, balanceBefore: true, balanceAfter: true, createdAt: true },
          take: 1
        }
      },
      orderBy: { creditedAt: 'desc' },
      take: 101
    });
    return rows.map((row) => ({
      ...row,
      faceValue: mapAmount4(row.faceValue, 'id_business_v2_gift_cards.face_value'),
      exchangeRate: mapRate8(row.exchangeRate, 'id_business_v2_gift_cards.exchange_rate'),
      costAmount: mapAmount4(row.costAmount, 'id_business_v2_gift_cards.cost_amount'),
      ledgerEntries: row.ledgerEntries.map((entry) => ({
        ...entry,
        balanceBefore: mapAmount4(
          entry.balanceBefore,
          'id_business_v2_balance_ledgers.balance_before'
        ),
        balanceAfter: mapAmount4(entry.balanceAfter, 'id_business_v2_balance_ledgers.balance_after')
      }))
    }));
  }

  async findSensitiveGiftCard(giftCardId: string, tx?: V2CommandTransaction) {
    return (tx ?? this.prisma).idBusinessV2GiftCard.findUnique({
      where: { id: giftCardId },
      select: { id: true, codeEncrypted: true, codeMasked: true }
    });
  }

  verifySensitiveApproval(input: { approvalId?: string; requesterId: string; objectId: string }) {
    return verifySensitiveAccessApproval(this.prisma, {
      approvalId: input.approvalId,
      requesterId: input.requesterId,
      module: 'id_business_v2_gift_card',
      fieldName: 'code',
      objectType: 'id_business_v2_gift_card',
      objectId: input.objectId
    });
  }

  async findMetadataInTransaction(tx: V2CommandTransaction, giftCardId: string) {
    return tx.idBusinessV2GiftCard.findUnique({
      where: { id: giftCardId },
      select: {
        id: true,
        codeMasked: true,
        supplierOptionId: true,
        remark: true,
        account: { select: { lossReportedAt: true } }
      }
    });
  }

  async updateMetadataInTransaction(
    tx: V2CommandTransaction,
    input: { giftCardId: string; remark?: string | null; updatedByUserId?: string }
  ) {
    const row = await tx.idBusinessV2GiftCard.update({
      where: { id: input.giftCardId },
      data: { remark: input.remark, updatedByUserId: input.updatedByUserId },
      include: GIFT_CARD_RECORD_INCLUDE
    });
    return mapGiftCardRecord(row);
  }

  async lockCreditAccount(
    tx: V2CommandTransaction,
    accountId: string
  ): Promise<LockedGiftCardCreditAccountRow | null> {
    const rows = await tx.$queryRaw<
      Array<
        Omit<LockedGiftCardCreditAccountRow, 'currentBalance' | 'balanceCostAmount'> & {
          currentBalance: unknown;
          balanceCostAmount: unknown;
        }
      >
    >`
      SELECT
        account."id",
        account."apple_id_masked" AS "appleIdMasked",
        account."current_balance" AS "currentBalance",
        account."balance_cost_amount" AS "balanceCostAmount",
        account."sold_by_order_id" AS "soldByOrderId",
        account."ownership_transferred_at" AS "ownershipTransferredAt",
        account."loss_reported_at" AS "lossReportedAt",
        account."country_option_id" AS "countryOptionId",
        country_option."name" AS "countryName",
        country_option."currency_code" AS "currencyCode"
      FROM "id_business_v2_accounts" account
      INNER JOIN "id_business_v2_options" country_option
        ON country_option."id" = account."country_option_id"
      WHERE
        account."id" = ${accountId}
        AND account."deleted_at" IS NULL
        AND account."record_status" = 'active'
        AND account."loss_reported_at" IS NULL
      FOR UPDATE
    `;
    const account = rows[0];
    return account
      ? {
          ...account,
          currentBalance: mapAmount4(
            account.currentBalance,
            'id_business_v2_accounts.current_balance'
          ),
          balanceCostAmount: mapAmount4(
            account.balanceCostAmount,
            'id_business_v2_accounts.balance_cost_amount'
          )
        }
      : null;
  }

  async findCreditReplay(tx: V2CommandTransaction, idempotencyKey: string) {
    const row = await tx.idBusinessV2BalanceLedger.findUnique({
      where: { idempotencyKey },
      include: { giftCard: true }
    });
    return row
      ? {
          ...mapCreditLedger(row),
          giftCard: row.giftCard ? mapCreditGiftCard(row.giftCard) : null
        }
      : null;
  }

  async findCreditOptions(
    tx: V2CommandTransaction,
    input: {
      countryOptionId: string;
      cardNameOptionId?: string;
      supplierOptionId: string;
    }
  ) {
    const [country, cardName, supplier] = await Promise.all([
      tx.idBusinessV2Option.findFirst({
        where: {
          id: input.countryOptionId,
          type: 'country',
          status: 'active',
          deletedAt: null
        },
        select: { id: true }
      }),
      tx.idBusinessV2Option.findFirst({
        where: {
          id: input.cardNameOptionId,
          type: 'gift_card_name',
          status: 'active',
          deletedAt: null
        },
        select: { id: true, name: true },
        orderBy: input.cardNameOptionId
          ? undefined
          : [{ sortOrder: 'asc' }, { name: 'asc' }, { id: 'asc' }]
      }),
      tx.idBusinessV2Option.findFirst({
        where: {
          id: input.supplierOptionId,
          type: 'topup_supplier',
          status: 'active',
          deletedAt: null
        },
        select: { id: true, name: true }
      })
    ]);
    return { country, cardName, supplier };
  }

  findFinanceAccount(tx: V2CommandTransaction, accountId: string) {
    return tx.idBusinessV2FinanceAccount.findUnique({ where: { id: accountId } });
  }

  async hasGiftCardCodeHash(tx: V2CommandTransaction, codeHash: string) {
    return tx.idBusinessV2GiftCard.findUnique({
      where: { codeHash },
      select: { id: true }
    });
  }

  updateGiftCard(
    tx: V2CommandTransaction,
    giftCardId: string,
    data: Prisma.IdBusinessV2GiftCardUncheckedUpdateInput
  ) {
    return tx.idBusinessV2GiftCard.update({ where: { id: giftCardId }, data });
  }

  async updateMappedGiftCard(
    tx: V2CommandTransaction,
    giftCardId: string,
    data: Prisma.IdBusinessV2GiftCardUncheckedUpdateInput
  ) {
    const row = await tx.idBusinessV2GiftCard.update({ where: { id: giftCardId }, data });
    return mapCreditGiftCard(row);
  }

  findGiftCardLocator(tx: V2CommandTransaction, giftCardId: string) {
    return tx.idBusinessV2GiftCard.findUnique({
      where: { id: giftCardId },
      select: { accountId: true }
    });
  }

  findGiftCardCreditEntry(tx: V2CommandTransaction, giftCardId: string) {
    return tx.idBusinessV2BalanceLedger.findUnique({
      where: {
        giftCardId_entryType: { giftCardId, entryType: 'gift_card_credit' }
      },
      select: { id: true }
    });
  }

  findReversalForEntry(tx: V2CommandTransaction, reversalOfEntryId: string) {
    return tx.idBusinessV2BalanceLedger.findUnique({
      where: { reversalOfEntryId },
      select: { id: true, entryType: true }
    });
  }

  findAccountLossByIdempotencyKey(tx: V2CommandTransaction, idempotencyKey: string) {
    return tx.idBusinessV2AccountLoss.findUnique({
      where: { idempotencyKey },
      select: { id: true }
    });
  }

  async createCreditGiftCard(
    tx: V2CommandTransaction,
    data: Prisma.IdBusinessV2GiftCardUncheckedCreateInput
  ) {
    const row = await tx.idBusinessV2GiftCard.create({ data });
    return mapCreditGiftCard(row);
  }

  async createCreditLedger(
    tx: V2CommandTransaction,
    data: Prisma.IdBusinessV2BalanceLedgerUncheckedCreateInput
  ) {
    const row = await tx.idBusinessV2BalanceLedger.create({ data });
    return mapCreditLedger(row);
  }

  async updateCreditAccount(
    tx: V2CommandTransaction,
    input: {
      accountId: string;
      currentBalance: string;
      balanceCostAmount: string;
      updatedByUserId?: string;
    }
  ) {
    const row = await tx.idBusinessV2Account.update({
      where: { id: input.accountId },
      data: {
        currentBalance: input.currentBalance,
        balanceCostAmount: input.balanceCostAmount,
        updatedByUserId: input.updatedByUserId
      },
      select: {
        id: true,
        appleIdMasked: true,
        currentBalance: true,
        balanceCostAmount: true
      }
    });
    return {
      ...row,
      currentBalance: mapAmount4(row.currentBalance, 'id_business_v2_accounts.current_balance'),
      balanceCostAmount: mapAmount4(
        row.balanceCostAmount,
        'id_business_v2_accounts.balance_cost_amount'
      )
    } satisfies GiftCardCreditAccountRecord;
  }

  async lockReversalAccount(
    tx: V2CommandTransaction,
    accountId: string
  ): Promise<LockedGiftCardReversalAccountRow | null> {
    const rows = await tx.$queryRaw<
      Array<
        Omit<LockedGiftCardReversalAccountRow, 'currentBalance' | 'balanceCostAmount'> & {
          currentBalance: unknown;
          balanceCostAmount: unknown;
        }
      >
    >`
      SELECT
        account."id",
        account."apple_id_masked" AS "appleIdMasked",
        account."current_balance" AS "currentBalance",
        account."balance_cost_amount" AS "balanceCostAmount",
        account."ownership_transferred_at" AS "ownershipTransferredAt",
        account."record_status" AS "recordStatus",
        account."loss_reported_at" AS "lossReportedAt"
      FROM "id_business_v2_accounts" account
      WHERE account."id" = ${accountId} AND account."deleted_at" IS NULL
      FOR UPDATE
    `;
    const account = rows[0];
    return account
      ? {
          ...account,
          currentBalance: mapAmount4(
            account.currentBalance,
            'id_business_v2_accounts.current_balance'
          ),
          balanceCostAmount: mapAmount4(
            account.balanceCostAmount,
            'id_business_v2_accounts.balance_cost_amount'
          )
        }
      : null;
  }

  async lockGiftCard(
    tx: V2CommandTransaction,
    giftCardId: string
  ): Promise<LockedGiftCardReversalRow | null> {
    const rows = await tx.$queryRaw<
      Array<
        Omit<LockedGiftCardReversalRow, 'faceValue' | 'exchangeRate' | 'costAmount'> & {
          faceValue: unknown;
          exchangeRate: unknown;
          costAmount: unknown;
        }
      >
    >`
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
      WHERE "id" = ${giftCardId}
      FOR UPDATE
    `;
    const giftCard = rows[0];
    return giftCard
      ? {
          ...giftCard,
          faceValue: mapAmount4(giftCard.faceValue, 'id_business_v2_gift_cards.face_value'),
          exchangeRate: mapRate8(giftCard.exchangeRate, 'id_business_v2_gift_cards.exchange_rate'),
          costAmount: mapAmount4(giftCard.costAmount, 'id_business_v2_gift_cards.cost_amount')
        }
      : null;
  }
}

function mapGiftCardRecord(row: GiftCardPersistenceRow): GiftCardRecord {
  return {
    ...row,
    faceValue: mapAmount4(row.faceValue, 'id_business_v2_gift_cards.face_value'),
    exchangeRate: mapRate8(row.exchangeRate, 'id_business_v2_gift_cards.exchange_rate'),
    exchangeRatePrefilledValue:
      row.exchangeRatePrefilledValue === null
        ? null
        : mapRate8(
            row.exchangeRatePrefilledValue,
            'id_business_v2_gift_cards.exchange_rate_prefilled_value'
          ),
    costAmount: mapAmount4(row.costAmount, 'id_business_v2_gift_cards.cost_amount'),
    purchaseOriginalAmount: mapAmount4(
      row.purchaseOriginalAmount,
      'id_business_v2_gift_cards.purchase_original_amount'
    ),
    purchaseFxRateToCny: mapRate8(
      row.purchaseFxRateToCny,
      'id_business_v2_gift_cards.purchase_fx_rate_to_cny'
    ),
    supplierRefundAmount: mapAmount4(
      row.supplierRefundAmount,
      'id_business_v2_gift_cards.supplier_refund_amount'
    ),
    supplierRefundAmountCny: mapAmount4(
      row.supplierRefundAmountCny,
      'id_business_v2_gift_cards.supplier_refund_amount_cny'
    ),
    ledgerEntries: row.ledgerEntries.map((entry) => ({
      ...entry,
      balanceBefore: mapAmount4(
        entry.balanceBefore,
        'id_business_v2_balance_ledgers.balance_before'
      ),
      balanceAfter: mapAmount4(entry.balanceAfter, 'id_business_v2_balance_ledgers.balance_after'),
      costBefore: mapAmount4(entry.costBefore, 'id_business_v2_balance_ledgers.cost_before'),
      costAfter: mapAmount4(entry.costAfter, 'id_business_v2_balance_ledgers.cost_after'),
      averageCostBefore: mapRate8(
        entry.averageCostBefore,
        'id_business_v2_balance_ledgers.average_cost_before'
      ),
      averageCostAfter: mapRate8(
        entry.averageCostAfter,
        'id_business_v2_balance_ledgers.average_cost_after'
      ),
      reversedByEntry: entry.reversedByEntry
        ? {
            ...entry.reversedByEntry,
            balanceAmount: mapAmount4(
              entry.reversedByEntry.balanceAmount,
              'id_business_v2_balance_ledgers.balance_amount'
            ),
            costAmount: mapAmount4(
              entry.reversedByEntry.costAmount,
              'id_business_v2_balance_ledgers.cost_amount'
            )
          }
        : null
    }))
  };
}

function mapBalanceLedgerRecord(row: BalanceLedgerPersistenceRow): BalanceLedgerRecord {
  return {
    ...row,
    balanceAmount: mapAmount4(row.balanceAmount, 'id_business_v2_balance_ledgers.balance_amount'),
    costAmount: mapAmount4(row.costAmount, 'id_business_v2_balance_ledgers.cost_amount'),
    balanceBefore: mapAmount4(row.balanceBefore, 'id_business_v2_balance_ledgers.balance_before'),
    balanceAfter: mapAmount4(row.balanceAfter, 'id_business_v2_balance_ledgers.balance_after'),
    costBefore: mapAmount4(row.costBefore, 'id_business_v2_balance_ledgers.cost_before'),
    costAfter: mapAmount4(row.costAfter, 'id_business_v2_balance_ledgers.cost_after'),
    averageCostBefore: mapRate8(
      row.averageCostBefore,
      'id_business_v2_balance_ledgers.average_cost_before'
    ),
    averageCostAfter: mapRate8(
      row.averageCostAfter,
      'id_business_v2_balance_ledgers.average_cost_after'
    ),
    giftCard: row.giftCard
      ? {
          ...row.giftCard,
          faceValue: mapAmount4(row.giftCard.faceValue, 'id_business_v2_gift_cards.face_value')
        }
      : null
  };
}

function mapCreditGiftCard(
  row: Prisma.IdBusinessV2GiftCardGetPayload<Record<string, never>>
): GiftCardCreditRecord {
  return {
    ...row,
    faceValue: mapAmount4(row.faceValue, 'id_business_v2_gift_cards.face_value'),
    exchangeRate: mapRate8(row.exchangeRate, 'id_business_v2_gift_cards.exchange_rate'),
    exchangeRatePrefilledValue:
      row.exchangeRatePrefilledValue === null
        ? null
        : mapRate8(
            row.exchangeRatePrefilledValue,
            'id_business_v2_gift_cards.exchange_rate_prefilled_value'
          ),
    costAmount: mapAmount4(row.costAmount, 'id_business_v2_gift_cards.cost_amount'),
    purchaseOriginalAmount: mapAmount4(
      row.purchaseOriginalAmount,
      'id_business_v2_gift_cards.purchase_original_amount'
    ),
    purchaseFxRateToCny: mapRate8(
      row.purchaseFxRateToCny,
      'id_business_v2_gift_cards.purchase_fx_rate_to_cny'
    )
  };
}

function mapCreditLedger(
  row: Prisma.IdBusinessV2BalanceLedgerGetPayload<Record<string, never>>
): GiftCardCreditLedgerRecord {
  return {
    ...row,
    balanceAmount: mapAmount4(row.balanceAmount, 'id_business_v2_balance_ledgers.balance_amount'),
    costAmount: mapAmount4(row.costAmount, 'id_business_v2_balance_ledgers.cost_amount'),
    balanceBefore: mapAmount4(row.balanceBefore, 'id_business_v2_balance_ledgers.balance_before'),
    balanceAfter: mapAmount4(row.balanceAfter, 'id_business_v2_balance_ledgers.balance_after'),
    costBefore: mapAmount4(row.costBefore, 'id_business_v2_balance_ledgers.cost_before'),
    costAfter: mapAmount4(row.costAfter, 'id_business_v2_balance_ledgers.cost_after'),
    averageCostBefore: mapRate8(
      row.averageCostBefore,
      'id_business_v2_balance_ledgers.average_cost_before'
    ),
    averageCostAfter: mapRate8(
      row.averageCostAfter,
      'id_business_v2_balance_ledgers.average_cost_after'
    )
  };
}
