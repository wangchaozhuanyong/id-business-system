import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  ID_BUSINESS_V2_RENEWAL_WARNING_DEFAULT_DAYS,
  ID_BUSINESS_V2_RENEWAL_WARNING_SCOPE
} from '../../renewals/public-api';
import { PrismaService } from '../../../common/prisma/prisma.service';
import type { V2CommandTransaction } from '../../runtime/public-api';
import type { AccountSubscriptionState } from '../bank-recharge-account-subscription';

export type BankRechargeOrderFeeUpdate = Prisma.IdBusinessV2BankRechargeOrderUncheckedUpdateInput;

export function bankRechargeAccountFilter(
  keyword: string,
  emailHash: string | null,
  subscriptionState: AccountSubscriptionState = 'all',
  now = new Date(),
  warningBoundary = new Date()
): Prisma.IdBusinessV2ChatgptAccountWhereInput {
  const textFilter: Prisma.IdBusinessV2ChatgptAccountWhereInput = keyword
    ? {
        OR: [
          { emailMasked: { contains: keyword } },
          { remark: { contains: keyword } },
          ...(emailHash ? [{ emailHash }] : [])
        ]
      }
    : {};
  const subscriptionFilter: Prisma.IdBusinessV2ChatgptAccountWhereInput =
    subscriptionState === 'never_subscribed'
      ? { subscription: { is: null } }
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
                    OR: [{ status: { not: 'active' } }, { dueAt: { lte: now } }]
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

  subscriptionsForAccounts(ids: string[]) {
    return this.prisma.idBusinessV2BankRechargeSubscription.findMany({
      where: { accountId: { in: ids } },
      select: { accountId: true, status: true, dueAt: true, plan: true }
    });
  }

  subscriptionForAccount(tx: V2CommandTransaction, accountId: string) {
    return tx.idBusinessV2BankRechargeSubscription.findUnique({ where: { accountId } });
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
    return tx.idBusinessV2ChatgptAccount.findUnique({ where: { id } });
  }
  async hasAccountEmailHashes(emailHashes: string[]) {
    return (
      (await this.prisma.idBusinessV2ChatgptAccount.count({
        where: { emailHash: { in: emailHashes } }
      })) > 0
    );
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
  deleteAccount(tx: V2CommandTransaction, id: string) {
    return tx.idBusinessV2ChatgptAccount.delete({ where: { id } });
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
  findCardsByTail(tx: V2CommandTransaction, last4: string, currencyCode: string) {
    return tx.idBusinessV2BankRechargeCard.findMany({
      where: { last4, currencyCode, active: true },
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
    return tx.idBusinessV2BankRechargeOrder.findUnique({ where: { id } });
  }
  findOrderForCompletion(tx: V2CommandTransaction, id: string) {
    return tx.idBusinessV2BankRechargeOrder.findUnique({
      where: { id },
      include: { card: true, account: true, customer: true }
    });
  }
  findOrderByPaymentEvidence(
    tx: V2CommandTransaction,
    rechargeJobId: string,
    checkoutIdentifier: string,
    paymentEvidenceId: string
  ) {
    return tx.idBusinessV2BankRechargeOrder.findFirst({
      where: { OR: [{ rechargeJobId }, { checkoutIdentifier }, { paymentEvidenceId }] }
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
  financeFxSnapshot(
    tx: V2CommandTransaction,
    currency: Prisma.IdBusinessV2FinanceFxRateSnapshotWhereInput['currency'],
    id?: string
  ) {
    return tx.idBusinessV2FinanceFxRateSnapshot.findFirst({
      where: { currency, ...(id ? { id } : {}) },
      orderBy: [{ capturedAt: 'desc' }, { id: 'desc' }]
    });
  }
  createFinanceFxSnapshot(
    tx: V2CommandTransaction,
    data: Prisma.IdBusinessV2FinanceFxRateSnapshotUncheckedCreateInput
  ) {
    return tx.idBusinessV2FinanceFxRateSnapshot.create({ data });
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
