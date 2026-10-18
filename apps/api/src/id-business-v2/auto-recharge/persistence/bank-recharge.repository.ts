import { acquireMysqlTransactionLock } from '../../../common/prisma/mysql-transaction-lock';
import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  ID_BUSINESS_V2_RENEWAL_WARNING_DEFAULT_DAYS,
  ID_BUSINESS_V2_RENEWAL_WARNING_SCOPE
} from '../../renewals/public-api';
import { PrismaService } from '../../../common/prisma/prisma.service';
import type { V2CommandTransaction } from '../../runtime/public-api';
import { buildV2StringArrayContainsFilter } from '../../runtime/public-api';
import type { AccountSubscriptionState } from '../bank-recharge-account-subscription';
import {
  resolvedDeclinedPayment,
  resolvedVerificationFailureRecheck
} from '../recharge-noncharge-proof';

export type BankRechargeOrderFeeUpdate = Prisma.IdBusinessV2BankRechargeOrderUncheckedUpdateInput;

export function bankRechargeAccountFilter(
  keyword: string,
  emailHash: string | null,
  subscriptionState: AccountSubscriptionState = 'all',
  now = new Date(),
  warningBoundary = new Date(),
  emailSearchTokens: string[] = []
): Prisma.IdBusinessV2ChatgptAccountWhereInput {
  const textFilter: Prisma.IdBusinessV2ChatgptAccountWhereInput = keyword
    ? {
        OR: [
          { emailMasked: { contains: keyword } },
          { remark: { contains: keyword } },
          ...(emailSearchTokens.length
            ? [
                {
                  emailSearchTokens:
                    buildV2StringArrayContainsFilter<
                      Prisma.JsonFilter<'IdBusinessV2ChatgptAccount'>
                    >(emailSearchTokens)
                }
              ]
            : []),
          ...(emailHash ? [{ emailHash }] : [])
        ]
      }
    : {};
  const subscriptionFilter: Prisma.IdBusinessV2ChatgptAccountWhereInput =
    subscriptionState === 'never_subscribed'
      ? {
          OR: [{ subscription: { is: null } }, { subscription: { is: { status: 'cancelled' } } }]
        }
      : subscriptionState === 'active'
        ? {
            subscription: {
              is: {
                status: 'active',
                dueAt: { gt: warningBoundary }
              }
            }
          }
        : subscriptionState === 'due_soon'
          ? {
              subscription: {
                is: {
                  status: 'active',
                  dueAt: { gt: now, lte: warningBoundary }
                }
              }
            }
          : subscriptionState === 'expired'
            ? {
                subscription: {
                  is: {
                    OR: [{ status: 'expired' }, { status: 'active', dueAt: { lte: now } }]
                  }
                }
              }
            : subscriptionState === 'unknown'
              ? {
                  subscription: {
                    is: {
                      status: 'active',
                      dueAt: null
                    }
                  }
                }
              : {};
  return subscriptionState === 'all' ? textFilter : { AND: [textFilter, subscriptionFilter] };
}

@Injectable()
export class BankRechargeRepository {
  constructor(private readonly prisma: PrismaService) {}

  listAccounts(args: Prisma.IdBusinessV2ChatgptAccountFindManyArgs = {}) {
    return this.prisma.idBusinessV2ChatgptAccount.findMany({
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      ...args
    });
  }

  openingCardsForAccounts(ids: string[]) {
    return this.prisma.idBusinessV2BankRechargeOrder.findMany({
      where: {
        accountId: { in: ids },
        OR: [{ verifiedAt: { not: null } }, { status: { in: ['completed', 'refunded'] } }]
      },
      select: {
        accountId: true,
        channel: true,
        onlineRechargeCardId: true,
        onlineRechargeCard: { select: { id: true, last4: true, status: true } },
        cardId: true,
        cardLabelSnapshot: true,
        cardNumberSummaryEncrypted: true,
        cardDeletedAt: true,
        cardLast4: true,
        card: { select: { id: true, label: true, last4: true, numberEncrypted: true } }
      },
      orderBy: [{ openedAt: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }]
    });
  }

  subscriptionsForAccounts(ids: string[]) {
    return this.prisma.idBusinessV2BankRechargeSubscription.findMany({
      where: { accountId: { in: ids } },
      select: { accountId: true, status: true, dueAt: true, plan: true }
    });
  }

  subscriptionForAccount(tx: V2CommandTransaction, accountId: string) {
    return tx.idBusinessV2BankRechargeSubscription.findUnique({ where: { accountId } });
  }

  async hasUnreviewedVerifiedPayment(tx: V2CommandTransaction, accountId: string) {
    return Boolean(
      await tx.idBusinessV2BankRechargeOrder.findFirst({
        where: {
          accountId,
          source: 'automatic',
          verifiedAt: { not: null },
          deletedAt: null,
          status: { not: 'cancelled' },
          OR: [{ openedAt: null }, { dueAt: null }]
        },
        select: { id: true }
      })
    );
  }

  async hasUnresolvedRechargePayment(
    tx: V2CommandTransaction,
    accountId: string,
    accountKey: string | null
  ) {
    const jobs = await tx.idBusinessV2RechargeJob.findMany({
      where: {
        OR: [{ chatgptAccountId: accountId }, ...(accountKey ? [{ accountKey }] : [])],
        action: { in: ['prepare', 'flow', 'bitbrowser', 'server'] }
      },
      select: {
        id: true,
        ownerId: true,
        accountKey: true,
        plan: true,
        action: true,
        state: true,
        createdAt: true,
        updatedAt: true,
        result: true
      }
    });
    let unresolved = jobs.filter(({ result }) => {
      if (!result || typeof result !== 'object' || Array.isArray(result)) return false;
      const report = result as Record<string, unknown>;
      const attempted =
        report.payment_attempted === true ||
        report.payment_requests_sent === 1 ||
        report.confirmation_requests_sent === 1;
      const closed =
        (report.payment_status === 'paid' &&
          report.status === 'subscription_activated' &&
          report.payment_outcome === 'subscription_activated') ||
        report.payment_status === 'declined' ||
        report.operator_resolution === 'confirmed_no_bank_request' ||
        resolvedDeclinedPayment(report);
      return attempted && !closed;
    });
    const rechecks = unresolved.filter((job) => {
      const result = job.result as Record<string, unknown> | null;
      return job.accountKey && result?.recheck_only === true;
    });
    if (rechecks.length) {
      const records = await tx.idBusinessV2RechargeRecord.findMany({
        where: {
          OR: rechecks.map(({ accountKey, ownerId }) => ({ accountKey: accountKey!, ownerId })),
          fileKey: { startsWith: 'payments/' }
        },
        select: { ownerId: true, accountKey: true, fileKey: true, document: true }
      });
      unresolved = unresolved.filter((job) => !resolvedVerificationFailureRecheck(job, records));
    }
    if (!unresolved.length) return false;
    // 只读复查保留原任务的未知历史；严格核验后生成的原任务订单证明付款已闭合。
    const verifiedOrders = await tx.idBusinessV2BankRechargeOrder.findMany({
      where: {
        accountId,
        source: 'automatic',
        verifiedAt: { not: null },
        deletedAt: null,
        status: { not: 'cancelled' },
        OR: unresolved.map(({ id, ownerId }) => ({
          rechargeJobId: id,
          createdByUserId: ownerId
        }))
      },
      select: {
        rechargeJobId: true,
        createdByUserId: true,
        accountId: true,
        source: true,
        verifiedAt: true
      }
    });
    return unresolved.some(
      ({ id, ownerId }) =>
        !verifiedOrders.some(
          (order) =>
            order.rechargeJobId === id &&
            order.createdByUserId === ownerId &&
            order.accountId === accountId &&
            order.source === 'automatic' &&
            order.verifiedAt instanceof Date &&
            Number.isFinite(order.verifiedAt.getTime())
        )
    );
  }

  async renewalWarningDays() {
    const setting = await this.prisma.idBusinessV2RenewalWarningSetting.findUnique({
      where: { scope: ID_BUSINESS_V2_RENEWAL_WARNING_SCOPE }
    });
    return setting && setting.warningDays >= 1 && setting.warningDays <= 365
      ? setting.warningDays
      : ID_BUSINESS_V2_RENEWAL_WARNING_DEFAULT_DAYS;
  }
  countAccounts(where: Prisma.IdBusinessV2ChatgptAccountWhereInput) {
    return this.prisma.idBusinessV2ChatgptAccount.count({ where });
  }
  findAccount(tx: V2CommandTransaction, id: string) {
    return tx.idBusinessV2ChatgptAccount.findFirst({ where: { id, deletedAt: null } });
  }
  async hasAccountEmailHashes(emailHashes: string[]) {
    return (
      (await this.prisma.idBusinessV2ChatgptAccount.count({
        where: { emailHash: { in: emailHashes } }
      })) > 0
    );
  }
  registrationSourceAudits(accountIds: string[]) {
    // Historical account provenance remains readable after registration is retired.
    return this.prisma.auditLog.findMany({
      where: {
        module: 'id_business_v2',
        objectType: 'chatgpt_account',
        objectId: { in: accountIds },
        action: {
          in: [
            'id_business_v2.auto_registration.chatgpt_account.mirror',
            'id_business_v2.auto_registration.chatgpt_account.manual_registered_mirror'
          ]
        }
      },
      select: { objectId: true, action: true, afterData: true },
      orderBy: { createdAt: 'desc' }
    });
  }
  findAccountByEmailHash(tx: V2CommandTransaction, emailHash: string) {
    return tx.idBusinessV2ChatgptAccount.findUnique({ where: { emailHash } });
  }
  findAccountByOfficialKey(tx: V2CommandTransaction, officialAccountKey: string) {
    return tx.idBusinessV2ChatgptAccount.findUnique({ where: { officialAccountKey } });
  }
  loginNetworksByEmailHashes(emailHashes: string[]) {
    return this.prisma.idBusinessV2RechargeLoginNetwork.findMany({
      where: { emailHash: { in: emailHashes } }
    });
  }
  loginNetwork(tx: V2CommandTransaction, emailHash: string) {
    return tx.idBusinessV2RechargeLoginNetwork.findUnique({ where: { emailHash } });
  }
  createLoginNetwork(
    tx: V2CommandTransaction,
    args: Prisma.IdBusinessV2RechargeLoginNetworkCreateArgs
  ) {
    return tx.idBusinessV2RechargeLoginNetwork.create(args);
  }
  updateLoginNetwork(
    tx: V2CommandTransaction,
    args: Prisma.IdBusinessV2RechargeLoginNetworkUpdateArgs
  ) {
    return tx.idBusinessV2RechargeLoginNetwork.update(args);
  }
  createAccount(tx: V2CommandTransaction, args: Prisma.IdBusinessV2ChatgptAccountCreateArgs) {
    return tx.idBusinessV2ChatgptAccount.create(args);
  }
  updateAccount(tx: V2CommandTransaction, args: Prisma.IdBusinessV2ChatgptAccountUpdateArgs) {
    return tx.idBusinessV2ChatgptAccount.update(args);
  }
  async accountHasReferences(tx: V2CommandTransaction, id: string) {
    const [job, order, subscription, registration] = await Promise.all([
      tx.idBusinessV2RechargeJob.findFirst({
        where: { chatgptAccountId: id },
        select: { id: true }
      }),
      tx.idBusinessV2BankRechargeOrder.findFirst({
        where: { accountId: id },
        select: { id: true }
      }),
      tx.idBusinessV2BankRechargeSubscription.findUnique({
        where: { accountId: id },
        select: { id: true }
      }),
      tx.idBusinessV2RegistrationJob.findFirst({ where: { accountId: id }, select: { id: true } })
    ]);
    return Boolean(job || order || subscription || registration);
  }

  listCurrencies() {
    return this.prisma.idBusinessV2BankRechargeCurrency.findMany({ orderBy: { code: 'asc' } });
  }
  findCurrency(tx: V2CommandTransaction, code: string) {
    return tx.idBusinessV2BankRechargeCurrency.findUnique({ where: { code } });
  }
  createCurrency(
    tx: V2CommandTransaction,
    args: Prisma.IdBusinessV2BankRechargeCurrencyCreateArgs
  ) {
    return tx.idBusinessV2BankRechargeCurrency.create(args);
  }
  listCards() {
    return this.prisma.idBusinessV2BankRechargeCard.findMany({
      include: { currency: true },
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }]
    });
  }
  findCard(tx: V2CommandTransaction, id: string) {
    return tx.idBusinessV2BankRechargeCard.findUnique({ where: { id } });
  }
  findOnlineCard(tx: V2CommandTransaction, id: string) {
    return tx.onlineRechargeCard.findUnique({
      where: { id },
      select: { id: true, last4: true, status: true }
    });
  }
  findCardsByTail(tx: V2CommandTransaction, last4: string, cardId?: string | null) {
    return tx.idBusinessV2BankRechargeCard.findMany({
      where: { last4, ...(cardId ? { id: cardId } : {}) },
      take: 2
    });
  }
  createCard(tx: V2CommandTransaction, args: Prisma.IdBusinessV2BankRechargeCardCreateArgs) {
    return tx.idBusinessV2BankRechargeCard.create(args);
  }

  findRechargeJob(tx: V2CommandTransaction, id: string) {
    return tx.idBusinessV2RechargeJob.findUnique({ where: { id } });
  }

  findOrder(tx: V2CommandTransaction, id: string) {
    return tx.idBusinessV2BankRechargeOrder.findFirst({ where: { id, deletedAt: null } });
  }
  findOrderForCompletion(tx: V2CommandTransaction, id: string) {
    return tx.idBusinessV2BankRechargeOrder.findFirst({
      where: { id, deletedAt: null },
      include: {
        card: true,
        onlineRechargeCard: { select: { id: true, last4: true, status: true } },
        account: true,
        customer: true
      }
    });
  }
  async findOtherOrderByPaymentReference(
    tx: V2CommandTransaction,
    reference: string,
    id: string | null = null
  ) {
    await acquireMysqlTransactionLock(tx, 'bank-recharge-order-evidence');
    return tx.idBusinessV2BankRechargeOrder.findFirst({
      where: {
        ...(id ? { id: { not: id } } : {}),
        OR: [
          { paymentEvidenceId: reference },
          { manualEvidenceRef: reference },
          { checkoutIdentifier: reference }
        ]
      }
    });
  }
  async findOrderByPaymentEvidence(
    tx: V2CommandTransaction,
    rechargeJobId: string,
    checkoutIdentifier: string,
    paymentEvidenceId: string
  ) {
    await acquireMysqlTransactionLock(tx, 'bank-recharge-order-evidence');
    return tx.idBusinessV2BankRechargeOrder.findFirst({
      where: {
        OR: [
          { rechargeJobId },
          { checkoutIdentifier },
          { paymentEvidenceId },
          { manualEvidenceRef: paymentEvidenceId }
        ]
      }
    });
  }
  createOrder(tx: V2CommandTransaction, args: Prisma.IdBusinessV2BankRechargeOrderCreateArgs) {
    return tx.idBusinessV2BankRechargeOrder.create(args);
  }
  updateOrder(tx: V2CommandTransaction, args: Prisma.IdBusinessV2BankRechargeOrderUpdateArgs) {
    return tx.idBusinessV2BankRechargeOrder.update(args);
  }

  findSubscription(tx: V2CommandTransaction, accountId: string) {
    return tx.idBusinessV2BankRechargeSubscription.findUnique({ where: { accountId } });
  }
  findSubscriptionWithOrder(tx: V2CommandTransaction, accountId: string) {
    return tx.idBusinessV2BankRechargeSubscription.findUnique({
      where: { accountId },
      include: { currentOrder: { select: { createdAt: true } } }
    });
  }
  upsertSubscription(
    tx: V2CommandTransaction,
    data: {
      accountId: string;
      currentOrderId: string;
      customerId: string | null;
      plan: string;
      openedAt: Date;
      dueAt: Date | null;
    }
  ) {
    return tx.idBusinessV2BankRechargeSubscription.upsert({
      where: { accountId: data.accountId },
      create: { ...data, status: 'active' },
      update: {
        currentOrderId: data.currentOrderId,
        customerId: data.customerId,
        plan: data.plan,
        openedAt: data.openedAt,
        dueAt: data.dueAt,
        status: 'active'
      }
    });
  }
  cancelSubscriptionForOrder(tx: V2CommandTransaction, accountId: string, currentOrderId: string) {
    return tx.idBusinessV2BankRechargeSubscription.updateMany({
      where: { accountId, currentOrderId },
      data: { status: 'cancelled' }
    });
  }

  findCustomer(tx: V2CommandTransaction, id: string) {
    return tx.idBusinessV2Customer.findUnique({ where: { id } });
  }
  findFinanceAccount(tx: V2CommandTransaction, id: string) {
    return tx.idBusinessV2FinanceAccount.findUnique({ where: { id } });
  }
  findCompletionJournal(tx: V2CommandTransaction, orderId: string) {
    return tx.idBusinessV2FinanceJournal.findFirst({
      where: {
        sourceType: 'bank_recharge',
        sourceId: orderId,
        journalType: 'bank_recharge_completed',
        status: 'posted'
      },
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      include: { lines: true }
    });
  }
  listRefundJournals(tx: V2CommandTransaction, orderId: string) {
    return tx.idBusinessV2FinanceJournal.findMany({
      where: {
        sourceType: 'bank_recharge',
        sourceId: orderId,
        journalType: 'order_refund',
        status: 'posted'
      },
      include: { lines: true }
    });
  }
  findPostedJournal(tx: V2CommandTransaction, idempotencyKey: string) {
    return tx.idBusinessV2FinanceJournal.findUnique({ where: { idempotencyKey } });
  }
}
