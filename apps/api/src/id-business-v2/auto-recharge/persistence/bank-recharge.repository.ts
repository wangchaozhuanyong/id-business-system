import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';
import type { V2CommandTransaction } from '../../runtime/public-api';

@Injectable()
export class BankRechargeRepository {
  constructor(private readonly prisma: PrismaService) {}

  listAccounts() {
    return this.prisma.idBusinessV2ChatgptAccount.findMany({
      orderBy: { updatedAt: 'desc' },
      take: 500
    });
  }
  findAccount(tx: V2CommandTransaction, id: string) {
    return tx.idBusinessV2ChatgptAccount.findUnique({ where: { id } });
  }
  findAccountByEmailHash(tx: V2CommandTransaction, emailHash: string) {
    return tx.idBusinessV2ChatgptAccount.findUnique({ where: { emailHash } });
  }
  findAccountByOfficialKey(tx: V2CommandTransaction, officialAccountKey: string) {
    return tx.idBusinessV2ChatgptAccount.findUnique({ where: { officialAccountKey } });
  }
  createAccount(tx: V2CommandTransaction, args: Prisma.IdBusinessV2ChatgptAccountCreateArgs) {
    return tx.idBusinessV2ChatgptAccount.create(args);
  }
  updateAccount(tx: V2CommandTransaction, args: Prisma.IdBusinessV2ChatgptAccountUpdateArgs) {
    return tx.idBusinessV2ChatgptAccount.update(args);
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
      orderBy: { updatedAt: 'desc' },
      take: 500
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
  findPostedJournal(tx: V2CommandTransaction, idempotencyKey: string) {
    return tx.idBusinessV2FinanceJournal.findUnique({ where: { idempotencyKey } });
  }
}
