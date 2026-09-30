import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';
import type { V2CommandTransaction } from '../../runtime/public-api';

@Injectable()
export class BankRechargeCardRepository {
  constructor(private readonly prisma: PrismaService) {}

  list(where: Prisma.IdBusinessV2BankRechargeCardWhereInput, skip: number, take: number) {
    return this.prisma.idBusinessV2BankRechargeCard.findMany({
      where,
      select: {
        id: true,
        label: true,
        last4: true,
        expiry: true,
        currencyCode: true,
        active: true,
        remark1: true,
        remark2: true,
        numberEncrypted: true,
        createdAt: true,
        updatedAt: true
      },
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      skip,
      take
    });
  }
  count(where: Prisma.IdBusinessV2BankRechargeCardWhereInput) {
    return this.prisma.idBusinessV2BankRechargeCard.count({ where });
  }
  distinctChargedAccounts(cardIds: string[]) {
    if (!cardIds.length) return Promise.resolve([]);
    return this.prisma.idBusinessV2BankRechargeOrder.groupBy({
      by: ['cardId', 'accountId'],
      where: {
        cardId: { in: cardIds },
        accountId: { not: null },
        OR: [{ verifiedAt: { not: null } }, { status: { in: ['completed', 'refunded'] } }]
      }
    });
  }
  find(id: string) {
    return this.prisma.idBusinessV2BankRechargeCard.findUnique({ where: { id } });
  }
  findByNumberHash(numberHash: string) {
    return this.prisma.idBusinessV2BankRechargeCard.findUnique({
      where: { numberHash },
      select: { id: true, active: true }
    });
  }
  findInTransaction(tx: V2CommandTransaction, id: string) {
    return tx.idBusinessV2BankRechargeCard.findUnique({ where: { id } });
  }
  create(tx: V2CommandTransaction, data: Prisma.IdBusinessV2BankRechargeCardCreateInput) {
    return tx.idBusinessV2BankRechargeCard.create({ data });
  }
  update(
    tx: V2CommandTransaction,
    id: string,
    data: Prisma.IdBusinessV2BankRechargeCardUpdateInput
  ) {
    return tx.idBusinessV2BankRechargeCard.update({ where: { id }, data });
  }
  delete(tx: V2CommandTransaction, id: string) {
    return tx.idBusinessV2BankRechargeCard.delete({ where: { id } });
  }
  hasOrders(tx: V2CommandTransaction, id: string) {
    return tx.idBusinessV2BankRechargeOrder.findFirst({
      where: { cardId: id },
      select: { id: true }
    });
  }
  listOrders(id: string, skip: number, take: number) {
    return this.prisma.idBusinessV2BankRechargeOrder.findMany({
      where: {
        cardId: id,
        accountId: { not: null },
        OR: [{ verifiedAt: { not: null } }, { status: { in: ['completed', 'refunded'] } }]
      },
      select: {
        id: true,
        orderNo: true,
        accountId: true,
        account: { select: { emailMasked: true } },
        chargeAmount: true,
        chargeCurrencyCode: true,
        status: true,
        verifiedAt: true,
        createdAt: true
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip,
      take
    });
  }
  countOrders(id: string) {
    return this.prisma.idBusinessV2BankRechargeOrder.count({
      where: {
        cardId: id,
        accountId: { not: null },
        OR: [{ verifiedAt: { not: null } }, { status: { in: ['completed', 'refunded'] } }]
      }
    });
  }
}
